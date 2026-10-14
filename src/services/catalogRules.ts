import { ValidationError } from '../core/errors';

/**
 * What a merchant may say about its own catalogue items, and what it may not.
 *
 * An approved store starts with an empty catalogue, and until this existed nothing but a
 * direct database write could fill it: `GET /merchants/:id/menu` served an empty list, and
 * the order path refused outright with `Merchant catalog` not found. So the first item a
 * merchant adds is what turns an approved account into a store that can take work.
 *
 * The item is the merchant's own — its name, what it says, what it costs, whether it is on
 * the menu today, and the picture customers see. Two fields are the platform's:
 *
 * - `id` is the platform's handle, used by orders, the pricing engine and the audit trail;
 *   a merchant that could name it could name a row that does not exist.
 * - `sku` is refused rather than accepted, and one is generated instead. The column is
 *   `UNIQUE` across the whole platform, so a self-service SKU is a squatting vector: the
 *   first store to claim `SEAFOOD-RUP-01` would lock every other store out of that string,
 *   and the collision would surface as a database error rather than as advice. A merchant's
 *   internal stock code is the merchant's business; the platform's unique key is not.
 *
 * `merchantId` is refused for the same reason the profile's fields are: the store is found by
 * the account that owns it, so there is nothing in the body for a caller to point elsewhere.
 */

export const MAX_CATALOG_ITEMS_PER_MERCHANT = 200;
/** BDT 1,000,000 per item. Not a policy ceiling — a typo guard on a number customers pay. */
export const MAX_ITEM_PRICE_BDT = 1_000_000;

const TEXT_LIMITS = {
  name: { min: 2, max: 160 },
  category: { min: 1, max: 160 },
  description: { max: 500 }
} as const;

const IMAGE_URL_MAX_LENGTH = 500;

/** Fields a merchant might reasonably try to set, and why each one is refused. */
const READ_ONLY_FIELDS: Record<string, string> = {
  id: 'the item id is the platform’s; orders and audit rows point at it',
  itemId: 'the item id is the platform’s; orders and audit rows point at it',
  merchantId: 'the store an item belongs to is the caller’s own, found from the token',
  sku: 'the SKU is unique across every store, so a self-service one could be taken from another merchant; the platform generates it',
  createdAt: 'the platform keeps these timestamps',
  updatedAt: 'the platform keeps these timestamps'
};

export interface NewCatalogItem {
  name: string;
  description: string | null;
  category: string;
  priceBdt: number;
  isAvailable: boolean;
  imageUrl: string | null;
}

export interface CatalogItemChanges {
  name?: string;
  description?: string | null;
  category?: string;
  priceBdt?: number;
  isAvailable?: boolean;
  imageUrl?: string | null;
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
 * A price the customer will be charged, in BDT.
 *
 * Money is rounded to poisha everywhere else in this codebase (`Math.round(x * 100) / 100`),
 * so a price that carries more than two decimals is refused rather than silently rounded: a
 * merchant who typed `12.345` and was charged `12.35` has been told something untrue. Zero and
 * negative prices are refused because an order line has to cost something — a giveaway is a
 * coupon, not an item priced at nothing.
 */
function parsePrice(raw: unknown): number {
  if (raw === undefined || raw === null) {
    throw new ValidationError("Field 'priceBdt' is required", { field: 'priceBdt' });
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ValidationError("Field 'priceBdt' must be a number", { field: 'priceBdt' });
  }
  if (raw <= 0) {
    throw new ValidationError("Field 'priceBdt' must be greater than 0", { field: 'priceBdt' });
  }
  if (raw > MAX_ITEM_PRICE_BDT) {
    throw new ValidationError(
      `Field 'priceBdt' must be at most ${MAX_ITEM_PRICE_BDT}`,
      { field: 'priceBdt' }
    );
  }

  const rounded = Math.round(raw * 100) / 100;
  if (Math.abs(raw - rounded) > 1e-9) {
    throw new ValidationError('Field \'priceBdt\' must have at most 2 decimal places', {
      field: 'priceBdt'
    });
  }
  return rounded;
}

/**
 * The picture customers see. Only `http(s)` is accepted: the value is rendered by clients and
 * is stored for every visitor of the storefront to fetch, so `javascript:` or a bare string
 * is a way to make somebody else's browser do something the merchant chose.
 */
function parseImageUrl(raw: unknown): string | null | undefined {
  const value = parseText(raw, 'imageUrl', { min: 0, max: IMAGE_URL_MAX_LENGTH }, { nullable: true });
  if (value === undefined || value === null) return value;
  if (value === '') return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Field 'imageUrl' must be an http(s) URL", { field: 'imageUrl' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError("Field 'imageUrl' must be an http(s) URL", { field: 'imageUrl' });
  }
  return value;
}

function refuseReadOnlyFields(body: Record<string, unknown>): void {
  for (const [field, reason] of Object.entries(READ_ONLY_FIELDS)) {
    if (body[field] !== undefined) {
      throw new ValidationError(`Field '${field}' cannot be set: ${reason}`, { field });
    }
  }
}

/**
 * Reads a new item, filling in what a merchant may reasonably leave out.
 *
 * `name` and `priceBdt` are required — an item with neither is not on a menu. `category` is
 * optional and defaults to the store's own category, so adding the first item to a seafood
 * restaurant is one line rather than a form. Availability defaults to true: an item a merchant
 * has just described is one they intend to sell.
 */
export function parseNewCatalogItem(
  body: Record<string, unknown>,
  storeCategory: string
): NewCatalogItem {
  refuseReadOnlyFields(body);

  const name = parseText(body.name, 'name', TEXT_LIMITS.name);
  if (name === undefined || name === null) {
    throw new ValidationError("Field 'name' is required", { field: 'name' });
  }

  const category = parseText(body.category, 'category', TEXT_LIMITS.category);
  const description = parseText(body.description, 'description', TEXT_LIMITS.description, {
    nullable: true
  });
  const imageUrl = parseImageUrl(body.imageUrl);

  if (body.isAvailable !== undefined && typeof body.isAvailable !== 'boolean') {
    throw new ValidationError("Field 'isAvailable' must be a boolean", { field: 'isAvailable' });
  }

  return {
    name,
    // A missing description is a null one: the column is nullable and the storefront shows
    // nothing rather than the string "undefined".
    description: description ?? null,
    category: category && category !== null ? category : storeCategory,
    priceBdt: parsePrice(body.priceBdt),
    isAvailable: body.isAvailable === undefined ? true : body.isAvailable,
    imageUrl: imageUrl ?? null
  };
}

/**
 * Reads an edit to an existing item, refusing anything the merchant does not own.
 *
 * As with the business profile: ignoring `sku` in the body would let a caller believe they had
 * set it, so every read-only field is answered with a `400` naming the field and the reason. A
 * request that changes nothing is refused rather than reported as success.
 */
export function parseCatalogItemChanges(body: Record<string, unknown>): CatalogItemChanges {
  refuseReadOnlyFields(body);

  const changes: CatalogItemChanges = {};

  const name = parseText(body.name, 'name', TEXT_LIMITS.name);
  if (name !== undefined && name !== null) changes.name = name;

  const category = parseText(body.category, 'category', TEXT_LIMITS.category);
  if (category !== undefined && category !== null) changes.category = category;

  // A description may be cleared outright, which is how a merchant removes stale wording.
  const description = parseText(body.description, 'description', TEXT_LIMITS.description, {
    nullable: true
  });
  if (description !== undefined) changes.description = description;

  if (body.priceBdt !== undefined) changes.priceBdt = parsePrice(body.priceBdt);

  if (body.isAvailable !== undefined) {
    if (typeof body.isAvailable !== 'boolean') {
      throw new ValidationError("Field 'isAvailable' must be a boolean", { field: 'isAvailable' });
    }
    changes.isAvailable = body.isAvailable;
  }

  const imageUrl = parseImageUrl(body.imageUrl);
  if (imageUrl !== undefined) changes.imageUrl = imageUrl;

  if (Object.keys(changes).length === 0) {
    throw new ValidationError(
      'Provide at least one of name, description, category, priceBdt, isAvailable, imageUrl',
      { field: 'body' }
    );
  }

  return changes;
}
