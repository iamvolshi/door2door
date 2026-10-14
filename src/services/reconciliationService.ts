import { ValidationError } from '../core/errors';
import { logger } from '../core/logger';

export type LedgerEntryType = 
  | 'PAYMENT_CAPTURED'
  | 'MERCHANT_PAYOUT'
  | 'DRIVER_COMMISSION'
  | 'PLATFORM_FEE'
  | 'REFUND_PROCESSED'
  | 'PENALTY_CHARGED';

export type PaymentMethod = 'BKASH' | 'NAGAD' | 'ROCKET' | 'CARD' | 'CASH_ON_DELIVERY';

export interface LedgerEntry {
  id: string;
  orderId: string;
  transactionReference: string;
  paymentMethod: PaymentMethod;
  entryType: LedgerEntryType;
  debitAmount: number;
  creditAmount: number;
  currency: 'BDT';
  userId: string;
  metadata: Record<string, unknown>;
  recordedAt: Date;
}

export interface ReconciliationDiscrepancy {
  orderId: string;
  orderTotal: number;
  totalDebits: number;
  totalCredits: number;
  discrepancyAmount: number;
  status: 'BALANCED' | 'DISCREPANCY_DETECTED';
  details: string;
}

export class ReconciliationService {
  private ledger: LedgerEntry[] = [];
  private nextEntryId = 1;

  public recordEntry(entry: Omit<LedgerEntry, 'id' | 'recordedAt'>): LedgerEntry {
    if (entry.debitAmount < 0 || entry.creditAmount < 0) {
      throw new ValidationError('Debit and credit amounts must be non-negative');
    }

    if (entry.debitAmount === 0 && entry.creditAmount === 0) {
      throw new ValidationError('A ledger entry must have a non-zero debit or credit amount');
    }

    const record: LedgerEntry = {
      id: `led-${this.nextEntryId++}-${Date.now()}`,
      orderId: entry.orderId,
      transactionReference: entry.transactionReference,
      paymentMethod: entry.paymentMethod,
      entryType: entry.entryType,
      debitAmount: Math.round(entry.debitAmount * 100) / 100,
      creditAmount: Math.round(entry.creditAmount * 100) / 100,
      currency: entry.currency || 'BDT',
      userId: entry.userId,
      metadata: entry.metadata || {},
      recordedAt: new Date(),
    };

    this.ledger.push(record);
    logger.info('Reconciliation ledger entry created', {
      entryId: record.id,
      orderId: record.orderId,
      type: record.entryType,
      debit: record.debitAmount,
      credit: record.creditAmount,
    });

    return record;
  }

  public recordOrderSettlement(
    orderId: string,
    transactionRef: string,
    paymentMethod: PaymentMethod,
    totalAmountPaid: number,
    merchantPayout: number,
    driverCommission: number,
    platformCommission: number,
    customerId: string,
    merchantId: string,
    driverId: string
  ): LedgerEntry[] {
    const sumBreakdown = Math.round((merchantPayout + driverCommission + platformCommission) * 100) / 100;
    const totalPaid = Math.round(totalAmountPaid * 100) / 100;

    if (Math.abs(sumBreakdown - totalPaid) > 0.01) {
      throw new ValidationError(
        `Settlement breakdown sum (${sumBreakdown} BDT) does not equal total amount paid (${totalPaid} BDT)`
      );
    }

    const entries: LedgerEntry[] = [];

    // Customer payment debit to cash/gateway
    entries.push(
      this.recordEntry({
        orderId,
        transactionReference: transactionRef,
        paymentMethod,
        entryType: 'PAYMENT_CAPTURED',
        debitAmount: totalPaid,
        creditAmount: 0,
        currency: 'BDT',
        userId: customerId,
        metadata: { role: 'CUSTOMER' },
      })
    );

    // Merchant payout credit
    entries.push(
      this.recordEntry({
        orderId,
        transactionReference: transactionRef,
        paymentMethod,
        entryType: 'MERCHANT_PAYOUT',
        debitAmount: 0,
        creditAmount: merchantPayout,
        currency: 'BDT',
        userId: merchantId,
        metadata: { role: 'MERCHANT' },
      })
    );

    // Driver commission credit
    entries.push(
      this.recordEntry({
        orderId,
        transactionReference: transactionRef,
        paymentMethod,
        entryType: 'DRIVER_COMMISSION',
        debitAmount: 0,
        creditAmount: driverCommission,
        currency: 'BDT',
        userId: driverId,
        metadata: { role: 'DRIVER' },
      })
    );

    // Platform revenue credit
    entries.push(
      this.recordEntry({
        orderId,
        transactionReference: transactionRef,
        paymentMethod,
        entryType: 'PLATFORM_FEE',
        debitAmount: 0,
        creditAmount: platformCommission,
        currency: 'BDT',
        userId: 'PLATFORM_SYSTEM',
        metadata: { role: 'PLATFORM' },
      })
    );

    return entries;
  }

  public getEntriesForOrder(orderId: string): LedgerEntry[] {
    return this.ledger.filter((e) => e.orderId === orderId);
  }

  public reconcileOrder(orderId: string, expectedOrderTotal: number): ReconciliationDiscrepancy {
    const entries = this.getEntriesForOrder(orderId);
    let totalDebits = 0;
    let totalCredits = 0;

    for (const e of entries) {
      totalDebits += e.debitAmount;
      totalCredits += e.creditAmount;
    }

    totalDebits = Math.round(totalDebits * 100) / 100;
    totalCredits = Math.round(totalCredits * 100) / 100;
    const discrepancyAmount = Math.round(Math.abs(totalDebits - totalCredits) * 100) / 100;
    const orderMismatch = Math.round(Math.abs(totalDebits - expectedOrderTotal) * 100) / 100;

    const isBalanced = discrepancyAmount === 0 && orderMismatch === 0;

    return {
      orderId,
      orderTotal: expectedOrderTotal,
      totalDebits,
      totalCredits,
      discrepancyAmount,
      status: isBalanced ? 'BALANCED' : 'DISCREPANCY_DETECTED',
      details: isBalanced
        ? 'All captured debits match total credit disbursements and order totals.'
        : `Discrepancy found: Debits (${totalDebits}) vs Credits (${totalCredits}) vs Expected (${expectedOrderTotal})`,
    };
  }

  public getAllEntries(): LedgerEntry[] {
    return [...this.ledger];
  }

  public clearLedger(): void {
    this.ledger = [];
  }
}

export const reconciliationService = new ReconciliationService();
