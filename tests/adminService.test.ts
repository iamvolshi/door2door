import { AdminService, AdminUser, ROLE_PERMISSIONS } from '../src/admin/adminService';
import { AuditLogger } from '../src/admin/auditLog';
import { PromoAnnouncementManager } from '../src/admin/promoAnnouncementManager';

describe('Admin Operations, RBAC, and Audit Logging', () => {
  let auditLogger: AuditLogger;
  let promoManager: PromoAnnouncementManager;
  let adminService: AdminService;

  const superAdmin: Omit<AdminUser, 'createdAt'> = {
    id: 'admin_super_01',
    name: 'Super Admin User',
    email: 'super@chologori.com',
    role: 'SUPER_ADMIN',
    active: true
  };

  const opsManager: Omit<AdminUser, 'createdAt'> = {
    id: 'admin_ops_01',
    name: 'Operations Manager',
    email: 'ops@chologori.com',
    role: 'OPERATIONS_MANAGER',
    active: true
  };

  const supportAgent: Omit<AdminUser, 'createdAt'> = {
    id: 'admin_support_01',
    name: 'Support Agent',
    email: 'support@chologori.com',
    role: 'SUPPORT_AGENT',
    active: true
  };

  beforeEach(() => {
    auditLogger = new AuditLogger();
    promoManager = new PromoAnnouncementManager();
    adminService = new AdminService(auditLogger, promoManager);

    adminService.registerAdmin('SYSTEM', superAdmin, { ipAddress: '127.0.0.1' });
    adminService.registerAdmin(superAdmin.id, opsManager, { ipAddress: '127.0.0.1' });
    adminService.registerAdmin(superAdmin.id, supportAgent, { ipAddress: '127.0.0.1' });
  });

  describe('RBAC and Privilege Verification', () => {
    it('should verify correct permissions mapped to roles', () => {
      expect(adminService.hasPermission(superAdmin.id, 'MANAGE_ADMINS')).toBe(true);
      expect(adminService.hasPermission(superAdmin.id, 'APPROVE_MERCHANT')).toBe(true);
      expect(adminService.hasPermission(opsManager.id, 'APPROVE_MERCHANT')).toBe(true);
      expect(adminService.hasPermission(opsManager.id, 'MANAGE_ADMINS')).toBe(false);
      expect(adminService.hasPermission(supportAgent.id, 'APPROVE_MERCHANT')).toBe(false);
      expect(adminService.hasPermission(supportAgent.id, 'RESOLVE_DISPUTES')).toBe(true);
    });

    it('should block unauthorized roles from performing restricted operations', () => {
      adminService.submitMerchantApplication({
        id: 'app_m_1',
        tradeLicenseNumber: 'TRD-12345',
        shopName: 'Cox Seafood Delights',
        ownerName: 'Rahim Chowdhury',
        phone: '+8801700000001',
        zoneId: 'cox_bazar_core'
      });

      expect(() => {
        adminService.reviewMerchantApplication(supportAgent.id, 'app_m_1', 'APPROVE');
      }).toThrow(/Forbidden/);
    });
  });

  describe('Merchant and Rider Application Workflows', () => {
    it('should approve merchant application and record audit log', () => {
      adminService.submitMerchantApplication({
        id: 'app_m_2',
        tradeLicenseNumber: 'TRD-99881',
        shopName: 'Kolatoli Grill',
        ownerName: 'Tanvir Hasan',
        phone: '+8801700000002',
        zoneId: 'cox_bazar_beach'
      });

      const reviewed = adminService.reviewMerchantApplication(
        opsManager.id,
        'app_m_2',
        'APPROVE',
        'All documents verified',
        { ipAddress: '192.168.1.10', deviceSignature: 'chrome-mac' }
      );

      expect(reviewed.status).toBe('APPROVED');
      expect(reviewed.reviewedBy).toBe(opsManager.id);

      const logs = auditLogger.getEntries({ targetId: 'app_m_2' });
      expect(logs.length).toBe(1);
      expect(logs[0].action).toBe('MERCHANT_APPLICATION_APPROVE');
      expect(logs[0].actorId).toBe(opsManager.id);
    });

    it('should reject rider application with reason', () => {
      adminService.submitRiderApplication({
        id: 'app_r_1',
        nidNumber: 'NID-9876543210',
        fullName: 'Karim Ullah',
        phone: '+8801800000002',
        vehicleType: 'MOTORCYCLE',
        zoneId: 'cox_bazar_core'
      });

      const reviewed = adminService.reviewRiderApplication(
        opsManager.id,
        'app_r_1',
        'REJECT',
        'Invalid driving license submitted'
      );

      expect(reviewed.status).toBe('REJECTED');
      expect(reviewed.rejectionReason).toBe('Invalid driving license submitted');
    });
  });

  describe('Account Suspension and Reinstatement', () => {
    it('should suspend and lift suspension on abusive customer or merchant', () => {
      adminService.suspendAccount(
        opsManager.id,
        'CUSTOMER',
        'cust_999',
        'Repeated fraudulent payment chargebacks'
      );

      expect(adminService.isAccountSuspended('CUSTOMER', 'cust_999')).toBe(true);

      const lifted = adminService.liftSuspension(opsManager.id, 'CUSTOMER', 'cust_999');
      expect(lifted).toBe(true);
      expect(adminService.isAccountSuspended('CUSTOMER', 'cust_999')).toBe(false);
    });
  });

  describe('Dispute and Refund Lifecycle', () => {
    it('should resolve dispute with full refund', () => {
      adminService.openDispute({
        id: 'disp_101',
        orderId: 'ord_555',
        customerId: 'cust_01',
        merchantId: 'merch_01',
        reason: 'Food spilled entirely in transit',
        disputeAmount: 450
      });

      const resolved = adminService.resolveDispute(
        supportAgent.id,
        'disp_101',
        'REFUND_FULL',
        undefined,
        'Customer submitted photo proof'
      );

      expect(resolved.status).toBe('RESOLVED_REFUND');
      expect(resolved.refundAmount).toBe(450);
      expect(resolved.resolvedBy).toBe(supportAgent.id);
    });

    it('should reject invalid partial refund amount above dispute limit', () => {
      adminService.openDispute({
        id: 'disp_102',
        orderId: 'ord_556',
        customerId: 'cust_02',
        merchantId: 'merch_01',
        reason: 'Missing cold beverage',
        disputeAmount: 100
      });

      expect(() => {
        adminService.resolveDispute(
          supportAgent.id,
          'disp_102',
          'REFUND_PARTIAL',
          250,
          'Invalid overcharge'
        );
      }).toThrow(/Invalid refund amount/);
    });
  });

  describe('Promo Codes & Announcements', () => {
    it('should validate percentage promo code within valid dates and bounds', () => {
      promoManager.createPromoCode(superAdmin.id, {
        code: 'COXSB20',
        description: '20% off for Coxs Bazar pilot launch',
        discountType: 'PERCENTAGE',
        discountValue: 20,
        minOrderAmount: 200,
        maxDiscountAmount: 100,
        validFrom: Date.now() - 1000,
        validTo: Date.now() + 86400000,
        usageLimit: 100,
        perUserLimit: 1,
        targetAudience: 'ALL',
        allowedZones: ['cox_bazar_core'],
        active: true
      });

      const validRes = promoManager.validatePromo('COXSB20', 400, 'cust_01', 'cox_bazar_core');
      expect(validRes.valid).toBe(true);
      expect(validRes.discountAmount).toBe(80);

      promoManager.recordPromoRedemption('COXSB20', 'cust_01');

      const secondAttempt = promoManager.validatePromo('COXSB20', 400, 'cust_01', 'cox_bazar_core');
      expect(secondAttempt.valid).toBe(false);
      expect(secondAttempt.errorCode).toBe('USER_LIMIT_REACHED');
    });

    it('should broadcast and filter active announcements', () => {
      promoManager.createAnnouncement(superAdmin.id, {
        title: 'Monsoon Alert',
        bengaliTitle: 'বর্ষার সতর্কতা',
        body: 'Heavy rainfall in Coxs Bazar coastal areas. Delivery time extended.',
        bengaliBody: 'কক্সবাজার উপকূলীয় এলাকায় ভারী বৃষ্টিপাত হচ্ছে।',
        targetAudience: 'RIDERS',
        targetZoneId: 'cox_bazar_core',
        priority: 'HIGH',
        active: true
      });

      const riderAnnouncements = promoManager.getActiveAnnouncements('RIDERS', 'cox_bazar_core');
      expect(riderAnnouncements.length).toBe(1);
      expect(riderAnnouncements[0].title).toBe('Monsoon Alert');

      const merchantAnnouncements = promoManager.getActiveAnnouncements('MERCHANTS', 'cox_bazar_core');
      expect(merchantAnnouncements.length).toBe(0);
    });
  });

  describe('Tamper-Evident Audit Logging', () => {
    it('should maintain SHA-256 chain integrity and detect tampering', () => {
      auditLogger.record('admin_1', 'LOGIN', 'SESSION', 'sess_1');
      auditLogger.record('admin_1', 'UPDATE_SETTINGS', 'SYSTEM_CONFIG', 'conf_1');

      const verifyOk = auditLogger.verifyIntegrity();
      expect(verifyOk.isValid).toBe(true);

      const entries = auditLogger.getEntries();
      // Tamper with metadata of an entry directly
      (entries[0] as any).metadata = { hacked: true };

      const verifyTampered = auditLogger.verifyIntegrity();
      expect(verifyTampered.isValid).toBe(false);
      expect(verifyTampered.corruptedIndex).toBe(0);
    });
  });
});
