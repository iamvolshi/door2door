import { AuditLogger, AuditLogEntry, AuditLogFilter } from './auditLog';
import { PromoAnnouncementManager, PromoCode, Announcement, PromoValidationResult } from './promoAnnouncementManager';

export type AdminRole =
  | 'SUPER_ADMIN'
  | 'OPERATIONS_MANAGER'
  | 'FINANCE_MANAGER'
  | 'SUPPORT_AGENT'
  | 'ZONE_DISPATCHER'
  | 'COMPLIANCE_OFFICER';

export type AdminPermission =
  | 'MANAGE_ADMINS'
  | 'APPROVE_MERCHANT'
  | 'REJECT_MERCHANT'
  | 'SUSPEND_MERCHANT'
  | 'APPROVE_RIDER'
  | 'REJECT_RIDER'
  | 'SUSPEND_RIDER'
  | 'SUSPEND_CUSTOMER'
  | 'MANAGE_PROMOS'
  | 'BROADCAST_ANNOUNCEMENTS'
  | 'RESOLVE_DISPUTES'
  | 'PROCESS_REFUNDS'
  | 'VIEW_AUDIT_LOGS'
  | 'VIEW_ANALYTICS'
  | 'MANAGE_DELIVERY_ZONES';

export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  SUPER_ADMIN: [
    'MANAGE_ADMINS',
    'APPROVE_MERCHANT',
    'REJECT_MERCHANT',
    'SUSPEND_MERCHANT',
    'APPROVE_RIDER',
    'REJECT_RIDER',
    'SUSPEND_RIDER',
    'SUSPEND_CUSTOMER',
    'MANAGE_PROMOS',
    'BROADCAST_ANNOUNCEMENTS',
    'RESOLVE_DISPUTES',
    'PROCESS_REFUNDS',
    'VIEW_AUDIT_LOGS',
    'VIEW_ANALYTICS',
    'MANAGE_DELIVERY_ZONES'
  ],
  OPERATIONS_MANAGER: [
    'APPROVE_MERCHANT',
    'REJECT_MERCHANT',
    'SUSPEND_MERCHANT',
    'APPROVE_RIDER',
    'REJECT_RIDER',
    'SUSPEND_RIDER',
    'SUSPEND_CUSTOMER',
    'BROADCAST_ANNOUNCEMENTS',
    'RESOLVE_DISPUTES',
    'VIEW_AUDIT_LOGS',
    'VIEW_ANALYTICS',
    'MANAGE_DELIVERY_ZONES'
  ],
  FINANCE_MANAGER: [
    'PROCESS_REFUNDS',
    'RESOLVE_DISPUTES',
    'MANAGE_PROMOS',
    'VIEW_AUDIT_LOGS',
    'VIEW_ANALYTICS'
  ],
  SUPPORT_AGENT: [
    'RESOLVE_DISPUTES',
    'PROCESS_REFUNDS',
    'VIEW_ANALYTICS'
  ],
  ZONE_DISPATCHER: [
    'APPROVE_RIDER',
    'REJECT_RIDER',
    'VIEW_ANALYTICS'
  ],
  COMPLIANCE_OFFICER: [
    'APPROVE_MERCHANT',
    'REJECT_MERCHANT',
    'SUSPEND_MERCHANT',
    'SUSPEND_RIDER',
    'SUSPEND_CUSTOMER',
    'VIEW_AUDIT_LOGS'
  ]
};

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  customPermissions?: AdminPermission[];
  active: boolean;
  createdAt: number;
}

export type ApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DOCUMENTS_REQUIRED';

export interface MerchantApplication {
  id: string;
  tradeLicenseNumber: string;
  shopName: string;
  ownerName: string;
  phone: string;
  zoneId: string;
  status: ApplicationStatus;
  rejectionReason?: string;
  submittedAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
}

export interface RiderApplication {
  id: string;
  nidNumber: string;
  fullName: string;
  phone: string;
  vehicleType: 'BICYCLE' | 'MOTORCYCLE' | 'WALKER' | 'EV_SCOOTER';
  licenseNumber?: string;
  zoneId: string;
  status: ApplicationStatus;
  rejectionReason?: string;
  submittedAt: number;
  reviewedAt?: number;
  reviewedBy?: string;
}

export type DisputeStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED_REFUND' | 'RESOLVED_REJECTED' | 'ESCALATED';

export interface DisputeRecord {
  id: string;
  orderId: string;
  customerId: string;
  merchantId: string;
  riderId?: string;
  reason: string;
  disputeAmount: number;
  refundAmount?: number;
  status: DisputeStatus;
  notes?: string;
  assignedTo?: string;
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface SuspensionRecord {
  targetType: 'MERCHANT' | 'RIDER' | 'CUSTOMER';
  targetId: string;
  reason: string;
  suspendedBy: string;
  suspendedAt: number;
  active: boolean;
}

export interface ContextMeta {
  ipAddress?: string;
  deviceSignature?: string;
}

export class AdminService {
  private admins: Map<string, AdminUser> = new Map();
  private merchantApps: Map<string, MerchantApplication> = new Map();
  private riderApps: Map<string, RiderApplication> = new Map();
  private disputes: Map<string, DisputeRecord> = new Map();
  private suspensions: Map<string, SuspensionRecord> = new Map();

  public readonly auditLogger: AuditLogger;
  public readonly promoManager: PromoAnnouncementManager;

  constructor(auditLogger?: AuditLogger, promoManager?: PromoAnnouncementManager) {
    this.auditLogger = auditLogger || new AuditLogger();
    this.promoManager = promoManager || new PromoAnnouncementManager();
  }

  public registerAdmin(superAdminId: string, adminData: Omit<AdminUser, 'createdAt'>, meta?: ContextMeta): AdminUser {
    if (this.admins.size > 0) {
      this.assertPermission(superAdminId, 'MANAGE_ADMINS');
    }

    const newAdmin: AdminUser = {
      ...adminData,
      createdAt: Date.now()
    };
    this.admins.set(newAdmin.id, newAdmin);

    this.auditLogger.record(
      superAdminId || 'SYSTEM',
      'CREATE_ADMIN',
      'ADMIN_USER',
      newAdmin.id,
      { role: newAdmin.role, email: newAdmin.email },
      meta
    );

    return { ...newAdmin };
  }

  public getAdmin(adminId: string): AdminUser | undefined {
    const admin = this.admins.get(adminId);
    return admin ? { ...admin } : undefined;
  }

  public hasPermission(adminId: string, permission: AdminPermission): boolean {
    const admin = this.admins.get(adminId);
    if (!admin || !admin.active) return false;
    if (admin.customPermissions && admin.customPermissions.includes(permission)) {
      return true;
    }
    const rolePerms = ROLE_PERMISSIONS[admin.role] || [];
    return rolePerms.includes(permission);
  }

  private assertPermission(adminId: string, permission: AdminPermission): AdminUser {
    const admin = this.admins.get(adminId);
    if (!admin || !admin.active) {
      throw new Error(`Unauthorized: Admin ${adminId} not found or inactive.`);
    }
    if (!this.hasPermission(adminId, permission)) {
      throw new Error(`Forbidden: Admin ${adminId} (${admin.role}) lacks permission ${permission}.`);
    }
    return admin;
  }

  // Merchant Application Workflow
  public submitMerchantApplication(app: Omit<MerchantApplication, 'status' | 'submittedAt'>): MerchantApplication {
    const newApp: MerchantApplication = {
      ...app,
      status: 'PENDING',
      submittedAt: Date.now()
    };
    this.merchantApps.set(newApp.id, newApp);
    return { ...newApp };
  }

  public reviewMerchantApplication(
    adminId: string,
    applicationId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_DOCUMENTS',
    reason?: string,
    meta?: ContextMeta
  ): MerchantApplication {
    const perm: AdminPermission = decision === 'APPROVE' ? 'APPROVE_MERCHANT' : 'REJECT_MERCHANT';
    this.assertPermission(adminId, perm);

    const app = this.merchantApps.get(applicationId);
    if (!app) {
      throw new Error(`Merchant application ${applicationId} not found.`);
    }

    if (decision === 'APPROVE') {
      app.status = 'APPROVED';
      app.rejectionReason = undefined;
    } else if (decision === 'REJECT') {
      app.status = 'REJECTED';
      app.rejectionReason = reason || 'Application rejected by compliance review.';
    } else {
      app.status = 'DOCUMENTS_REQUIRED';
      app.rejectionReason = reason || 'Further documentation required.';
    }

    app.reviewedAt = Date.now();
    app.reviewedBy = adminId;

    this.auditLogger.record(
      adminId,
      `MERCHANT_APPLICATION_${decision}`,
      'MERCHANT_APPLICATION',
      applicationId,
      { status: app.status, reason },
      meta
    );

    return { ...app };
  }

  // Rider Application Workflow
  public submitRiderApplication(app: Omit<RiderApplication, 'status' | 'submittedAt'>): RiderApplication {
    const newApp: RiderApplication = {
      ...app,
      status: 'PENDING',
      submittedAt: Date.now()
    };
    this.riderApps.set(newApp.id, newApp);
    return { ...newApp };
  }

  public reviewRiderApplication(
    adminId: string,
    applicationId: string,
    decision: 'APPROVE' | 'REJECT',
    reason?: string,
    meta?: ContextMeta
  ): RiderApplication {
    const perm: AdminPermission = decision === 'APPROVE' ? 'APPROVE_RIDER' : 'REJECT_RIDER';
    this.assertPermission(adminId, perm);

    const app = this.riderApps.get(applicationId);
    if (!app) {
      throw new Error(`Rider application ${applicationId} not found.`);
    }

    app.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    app.rejectionReason = decision === 'REJECT' ? reason : undefined;
    app.reviewedAt = Date.now();
    app.reviewedBy = adminId;

    this.auditLogger.record(
      adminId,
      `RIDER_APPLICATION_${decision}`,
      'RIDER_APPLICATION',
      applicationId,
      { status: app.status, reason },
      meta
    );

    return { ...app };
  }

  // Account Suspensions
  public suspendAccount(
    adminId: string,
    targetType: 'MERCHANT' | 'RIDER' | 'CUSTOMER',
    targetId: string,
    reason: string,
    meta?: ContextMeta
  ): SuspensionRecord {
    const permMap: Record<string, AdminPermission> = {
      MERCHANT: 'SUSPEND_MERCHANT',
      RIDER: 'SUSPEND_RIDER',
      CUSTOMER: 'SUSPEND_CUSTOMER'
    };
    this.assertPermission(adminId, permMap[targetType]);

    const suspensionKey = `${targetType}:${targetId}`;
    const record: SuspensionRecord = {
      targetType,
      targetId,
      reason,
      suspendedBy: adminId,
      suspendedAt: Date.now(),
      active: true
    };
    this.suspensions.set(suspensionKey, record);

    this.auditLogger.record(
      adminId,
      'SUSPEND_ACCOUNT',
      targetType,
      targetId,
      { reason },
      meta
    );

    return { ...record };
  }

  public liftSuspension(
    adminId: string,
    targetType: 'MERCHANT' | 'RIDER' | 'CUSTOMER',
    targetId: string,
    meta?: ContextMeta
  ): boolean {
    const permMap: Record<string, AdminPermission> = {
      MERCHANT: 'SUSPEND_MERCHANT',
      RIDER: 'SUSPEND_RIDER',
      CUSTOMER: 'SUSPEND_CUSTOMER'
    };
    this.assertPermission(adminId, permMap[targetType]);

    const suspensionKey = `${targetType}:${targetId}`;
    const record = this.suspensions.get(suspensionKey);
    if (!record || !record.active) return false;

    record.active = false;
    this.auditLogger.record(
      adminId,
      'LIFT_SUSPENSION',
      targetType,
      targetId,
      { liftedAt: Date.now() },
      meta
    );
    return true;
  }

  public isAccountSuspended(targetType: 'MERCHANT' | 'RIDER' | 'CUSTOMER', targetId: string): boolean {
    const record = this.suspensions.get(`${targetType}:${targetId}`);
    return !!record && record.active;
  }

  // Dispute & Refund Handling
  public openDispute(dispute: Omit<DisputeRecord, 'status' | 'createdAt'>): DisputeRecord {
    const newDispute: DisputeRecord = {
      ...dispute,
      status: 'OPEN',
      createdAt: Date.now()
    };
    this.disputes.set(newDispute.id, newDispute);
    return { ...newDispute };
  }

  public resolveDispute(
    adminId: string,
    disputeId: string,
    resolution: 'REFUND_FULL' | 'REFUND_PARTIAL' | 'REJECT',
    refundAmount?: number,
    notes?: string,
    meta?: ContextMeta
  ): DisputeRecord {
    this.assertPermission(adminId, 'RESOLVE_DISPUTES');

    const dispute = this.disputes.get(disputeId);
    if (!dispute) {
      throw new Error(`Dispute ${disputeId} not found.`);
    }

    if (resolution === 'REFUND_FULL' || resolution === 'REFUND_PARTIAL') {
      this.assertPermission(adminId, 'PROCESS_REFUNDS');
      const amt = resolution === 'REFUND_FULL' ? dispute.disputeAmount : (refundAmount || 0);
      if (amt <= 0 || amt > dispute.disputeAmount) {
        throw new Error(`Invalid refund amount ${amt} for dispute amount ${dispute.disputeAmount}`);
      }
      dispute.refundAmount = amt;
      dispute.status = 'RESOLVED_REFUND';
    } else {
      dispute.status = 'RESOLVED_REJECTED';
    }

    dispute.notes = notes;
    dispute.resolvedAt = Date.now();
    dispute.resolvedBy = adminId;

    this.auditLogger.record(
      adminId,
      `DISPUTE_${resolution}`,
      'DISPUTE',
      disputeId,
      { resolution, refundAmount: dispute.refundAmount, notes },
      meta
    );

    return { ...dispute };
  }

  public getDispute(disputeId: string): DisputeRecord | undefined {
    const d = this.disputes.get(disputeId);
    return d ? { ...d } : undefined;
  }

  public listDisputes(filter?: { status?: DisputeStatus; customerId?: string }): DisputeRecord[] {
    let list = Array.from(this.disputes.values());
    if (filter?.status) list = list.filter(d => d.status === filter.status);
    if (filter?.customerId) list = list.filter(d => d.customerId === filter.customerId);
    return list.map(d => ({ ...d }));
  }
}
