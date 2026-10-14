import { ValidationError } from '../core/errors';
import { parseAddressChanges, parseNewAddress, type AddressChanges } from './addressRules';

/**
 * What a merchant may change about its own store, and what it may not.
 *
 * The onboarding answers became a store at approval, and until this existed every one of them
 * was frozen: renaming the shop, correcting a description, moving it to a new address or
 * closing it for the day all needed an administrator and a database. What a merchant can do
 * itself is the shopfront — its name, what it says about itself, its category, where riders
 * collect from, and whether it is taking orders at all.
 *
 * What it cannot is deliberate, and each refusal says which of the four it is:
 *
 * - `tradeLicenseNumber` is a licensing fact, not a shop sign. It is unique platform-wide, so
 *   changing it is a decision about who may trade under a licence — an administrator's, and one
 *   the platform has no self-service path for.
 * - `phone` is the number the account signs in with; the store's copy exists so a rider can
 *   call it, and a merchant who could set it to anything could point delivery at a stranger.
 * - `rating` belongs to the customers who gave it.
 * - the shop address's `label` and `isDefault` are the platform's, not the shop's: the label is
 *   how the platform recognises the row as the place riders collect from.
 *
 * This module owns the other half of that too: a merchant whose store is missing can open one
 * itself. An approved merchant with no `merchants` row is a state the API cannot produce on its
 * own — approval creates the store in the same transaction that approves the account, so a store
 * that cannot be built leaves the account `PENDING` rather than permitted-but-inert — but a
 * database, a migration or a restored backup can, and until now the only answer to it was a `404`
 * from the two routes above and nowhere to go from there. `parseNewMerchantProfile` reads the
 * request that opens one, and the fields refused by an edit are required or defaulted by a
 * creation rather than forbidden outright.
 */

const TEXT_LIMITS = {
  businessName: { min: 2, max: 160 },
  // Onboarding caps every detail field at 160 characters, so anything already stored can be
  // sent back unchanged; a tighter limit here would make an existing value impossible to keep.
  category: { min: 1, max: 160 },
  description: { max: 500 }
} as const;

/** Fields a merchant might reasonably try to change, and why each one is refused. */
const READ_ONLY_MERCHANT_FIELDS: Record<string, string> = {
  tradeLicenseNumber:
    'the trade licence is a licensing decision, not a shop sign; an administrator handles it',
  phone: "the store's phone is the number the account signs in with",
  rating: 'the rating belongs to the customers who gave it',
  id: 'the store id is the platform’s',
  merchantId: 'the store id is the platform’s',
  ownerUserId: 'the owner of a store is fixed when it is created'
};

const READ_ONLY_ADDRESS_FIELDS: Record<string, string> = {
  label: 'the shop address is labelled by the platform, which is how riders find it',
  isDefault: 'a shop address is not a default pickup point a merchant can move'
};

export interface MerchantProfileChanges {
  businessName?: string;
  description?: string | null;
  category?: string;
  isOpen?: boolean;
  address?: AddressChanges;
}

/** A shop address, in the shape the store's `addressId` points at. */
export interface ShopAddress {
  streetAddress: string;
  area: string;
  district: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
}

/**
 * A shop address, parsed by the delivery-address rules with the customer's defaults dropped.
 *
 * Shared by the two places a shop address enters the platform — an administrator attaching one
 * to an approval (`POST /admin/registrations/:userId/approve`) and a merchant opening its own
 * store — so the two cannot disagree about what a shop address is, and neither can quietly
 * accept the `Home` label or the `isDefault` flag that belong to a customer's rows.
 *
 * Absent is `undefined` rather than an error: an approval's address is optional (a current
 * application carries its own), and whether a merchant must supply one is the caller's question,
 * not this parser's.
 */
export function parseShopAddress(raw: unknown): ShopAddress | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError("Field 'address' must be an object", { field: 'address' });
  }

  const parsed = parseNewAddress(raw as Record<string, unknown>);
  return {
    streetAddress: parsed.streetAddress,
    area: parsed.area,
    district: parsed.district,
    postalCode: parsed.postalCode,
    latitude: parsed.latitude,
    longitude: parsed.longitude
  };
}

/**
 * What it takes to open a store: the shopfront and the two facts the platform cannot invent.
 *
 * `tradeLicenseNumber` is required here even though `PATCH` refuses it. The two are not in
 * conflict: a store cannot exist without a licence, and the applicant is the only person who
 * knows it — which is why registration asks for it and checks it is unique — while *changing*
 * which licence a store trades under is a licensing decision an administrator makes. Stating it
 * once, at birth, is what registration already does.
 */
export interface NewMerchantProfile {
  businessName: string;
  tradeLicenseNumber: string;
  /** Absent when the merchant did not name one; the caller applies the platform's default. */
  category?: string;
  description?: string | null;
  isOpen?: boolean;
  address: ShopAddress;
}

/**
 * The fields a store does not set about itself, refused by name at creation too.
 *
 * A `phone` sent to an edit is refused because it is the number the account signs in with, and
 * that is just as true of the first request as of the hundredth: the store's copy is taken from
 * the account, never from the body. The rest are the platform's to assign (`rating` starts where
 * the schema starts it), and a caller who sends one is told so rather than left believing it
 * landed.
 */
const PLATFORM_OWNED_ON_CREATE: readonly string[] = [
  'id',
  'merchantId',
  'ownerUserId',
  'phone',
  'rating'
];

/** What registration allows a licence number to be, so a value it accepted is accepted here. */
const TRADE_LICENCE_LIMITS = { min: 1, max: 160 } as const;

/**
 * Reads the request that opens a store, and refuses anything the store does not own.
 *
 * Everything required here is something the platform cannot know: the name on the sign, the
 * licence it trades under, and where riders collect from. Everything else is defaulted the way
 * approval defaults it, so a store that approval would have built and one a merchant opens look
 * the same afterwards.
 */
export function parseNewMerchantProfile(body: Record<string, unknown>): NewMerchantProfile {
  for (const field of PLATFORM_OWNED_ON_CREATE) {
    if (body[field] !== undefined) {
      throw new ValidationError(
        `Field '${field}' cannot be set: ${READ_ONLY_MERCHANT_FIELDS[field]}`,
        { field }
      );
    }
  }

  const businessName = parseText(body.businessName, 'businessName', TEXT_LIMITS.businessName);
  if (businessName === undefined || businessName === null) {
    throw new ValidationError("Field 'businessName' is required to open a store", {
      field: 'businessName'
    });
  }

  const tradeLicenseNumber = parseText(
    body.tradeLicenseNumber,
    'tradeLicenseNumber',
    TRADE_LICENCE_LIMITS
  );
  if (tradeLicenseNumber === undefined || tradeLicenseNumber === null) {
    throw new ValidationError("Field 'tradeLicenseNumber' is required to open a store", {
      field: 'tradeLicenseNumber'
    });
  }

  const description = parseText(body.description, 'description', TEXT_LIMITS.description, {
    nullable: true
  });

  if (body.isOpen !== undefined && typeof body.isOpen !== 'boolean') {
    throw new ValidationError("Field 'isOpen' must be a boolean", { field: 'isOpen' });
  }

  // The address's platform-owned fields are refused here rather than in `parseShopAddress`, which
  // an approval also uses: the approve body has never accepted them and should keep not caring.
  const rawAddress = body.address;
  if (rawAddress !== null && typeof rawAddress === 'object' && !Array.isArray(rawAddress)) {
    for (const [field, reason] of Object.entries(READ_ONLY_ADDRESS_FIELDS)) {
      if ((rawAddress as Record<string, unknown>)[field] !== undefined) {
        throw new ValidationError(`Field 'address.${field}' cannot be set: ${reason}`, {
          field: `address.${field}`
        });
      }
    }
  }

  const address = parseShopAddress(rawAddress);
  if (!address) {
    throw new ValidationError(
      "Field 'address' is required to open a store: riders have to collect from somewhere",
      { field: 'address' }
    );
  }

  const profile: NewMerchantProfile = { businessName, tradeLicenseNumber, address };
  const category = parseText(body.category, 'category', TEXT_LIMITS.category);
  if (category !== undefined && category !== null) profile.category = category;
  if (description !== undefined) profile.description = description;
  if (body.isOpen !== undefined) profile.isOpen = body.isOpen;
  return profile;
}

/** Repeated whitespace collapses, the way registration stores it. */
function parseText(
  raw: unknown,
  field: string,
  limits: { min?: number; max: number },
  options: { nullable?: boolean } = {}
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) {
    if (options.nullable) return null;
    throw new ValidationError(`Field '${field}' must be a string`, { field });
  }
  if (typeof raw !== 'string') {
    throw new ValidationError(`Field '${field}' must be a string`, { field });
  }

  const value = raw.trim().replace(/\s+/g, ' ');
  const min = limits.min ?? 1;
  if (value.length < min || value.length > limits.max) {
    throw new ValidationError(
      `Field '${field}' must be between ${min} and ${limits.max} characters`,
      { field }
    );
  }
  return value;
}

/**
 * Reads a profile edit, and refuses anything the merchant does not own rather than ignoring it.
 *
 * Ignoring a `tradeLicenseNumber` in the body would let a caller believe they had changed it,
 * so every read-only field is answered with a `400` naming the field and the reason. A request
 * that changes nothing is refused for the same reason `PATCH /addresses/:id` refuses one: an
 * empty edit is a mistake, not a no-op to be reported as success.
 */
export function parseMerchantProfileChanges(body: Record<string, unknown>): MerchantProfileChanges {
  const changes: MerchantProfileChanges = {};

  for (const [field, reason] of Object.entries(READ_ONLY_MERCHANT_FIELDS)) {
    if (body[field] !== undefined) {
      throw new ValidationError(`Field '${field}' cannot be changed: ${reason}`, { field });
    }
  }

  const businessName = parseText(body.businessName, 'businessName', TEXT_LIMITS.businessName);
  if (businessName !== undefined && businessName !== null) changes.businessName = businessName;

  const category = parseText(body.category, 'category', TEXT_LIMITS.category);
  if (category !== undefined && category !== null) changes.category = category;

  // A description may be cleared outright, which is how a merchant removes stale wording.
  const description = parseText(body.description, 'description', TEXT_LIMITS.description, {
    nullable: true
  });
  if (description !== undefined) changes.description = description;

  if (body.isOpen !== undefined) {
    if (typeof body.isOpen !== 'boolean') {
      throw new ValidationError("Field 'isOpen' must be a boolean", { field: 'isOpen' });
    }
    changes.isOpen = body.isOpen;
  }

  if (body.address !== undefined) {
    if (body.address === null || typeof body.address !== 'object' || Array.isArray(body.address)) {
      throw new ValidationError("Field 'address' must be an object", { field: 'address' });
    }
    const raw = body.address as Record<string, unknown>;
    for (const [field, reason] of Object.entries(READ_ONLY_ADDRESS_FIELDS)) {
      if (raw[field] !== undefined) {
        throw new ValidationError(
          `Field 'address.${field}' cannot be changed: ${reason}`,
          { field: `address.${field}` }
        );
      }
    }
    // The address rules are reused rather than restated, so a shop address and a customer
    // address cannot disagree about what a postal code or a coordinate is.
    const address = parseAddressChanges(raw);

    // The shared rules let an optional field be sent as an empty string, which is how a
    // customer clears one. A shop is not an optional field: a store with no area or no street
    // is a store riders cannot find, so emptying these is refused rather than written. The
    // postal code may be cleared — not every shop has one.
    for (const field of ['streetAddress', 'area', 'district'] as const) {
      const value = address[field];
      if (value !== undefined && value.trim() === '') {
        throw new ValidationError(
          `Field 'address.${field}' cannot be emptied: a shop address has to stay somewhere riders can be sent`,
          { field: `address.${field}` }
        );
      }
    }

    changes.address = address;
  }

  if (Object.keys(changes).length === 0) {
    throw new ValidationError(
      'Provide at least one of businessName, description, category, isOpen, address',
      { field: 'body' }
    );
  }

  return changes;
}
