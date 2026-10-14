import { ValidationError } from '../core/errors';
import type { AddressRecord } from '../db/schema';

/**
 * Delivery-address rules for customers saving their own addresses.
 *
 * Everything here is validated before it reaches the database, and the parser is shared by
 * create and update so the two cannot drift apart. `district` stays required rather than
 * defaulting to the pilot district: an address that silently claims the wrong district is
 * worse than a form that asks.
 */
export const MAX_ADDRESSES_PER_CUSTOMER = 10;
export const DEFAULT_ADDRESS_LABEL = 'Home';

/** Pilot-area postcodes are four digits. Shared with shop onboarding, which asks for one too. */
export const POSTAL_CODE_PATTERN = /^\d{4}$/;

export interface NewAddressInput {
  label: string;
  streetAddress: string;
  area: string;
  district: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  /** Requests to make this the customer's default; the first address always is. */
  wantsDefault: boolean;
}

export interface AddressChanges {
  label?: string;
  streetAddress?: string;
  area?: string;
  district?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  wantsDefault?: boolean;
}

function parseText(raw: unknown, field: string, options: { min: number; max: number; required: boolean }): string | undefined {
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new ValidationError(`Field '${field}' is required`, { field });
    }
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new ValidationError(`Field '${field}' must be a string`, { field });
  }

  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length === 0 && !options.required) return '';
  if (value.length < options.min || value.length > options.max) {
    throw new ValidationError(
      `Field '${field}' must be between ${options.min} and ${options.max} characters`,
      { field }
    );
  }
  return value;
}

function parseCoordinate(raw: unknown, field: string, limit: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value)) {
    throw new ValidationError(`Field '${field}' must be a number`, { field });
  }
  if (value < -limit || value > limit) {
    throw new ValidationError(`Field '${field}' must be between ${-limit} and ${limit}`, { field });
  }
  return value;
}

/** Latitude and longitude are only useful together, so a lone half is a mistake. */
function parseCoordinatePair(
  body: Record<string, unknown>
): { latitude: number | null; longitude: number | null } {
  const latitude = parseCoordinate(body.latitude, 'latitude', 90);
  const longitude = parseCoordinate(body.longitude, 'longitude', 180);

  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new ValidationError('latitude and longitude must be supplied together', {
      field: latitude === undefined ? 'latitude' : 'longitude'
    });
  }
  return { latitude: latitude ?? null, longitude: longitude ?? null };
}

function parsePostalCode(raw: unknown): string | undefined {
  const value = parseText(raw, 'postalCode', { min: 0, max: 12, required: false });
  if (value === undefined || value === '') return value;
  if (!POSTAL_CODE_PATTERN.test(value)) {
    throw new ValidationError('Field \'postalCode\' must be 4 digits', { field: 'postalCode' });
  }
  return value;
}

/**
 * Where an order was delivered, as it was recorded when the order was placed.
 *
 * The address row an order names is shared and changeable: its owner may correct the street
 * they gave, or take the address off their list entirely. The delivery itself does not change
 * with either, so the order keeps its own copy of the address it was sent to, taken at
 * placement, and reads that in preference to the row ever after. Stored as JSON in a TEXT
 * column, which is how the platform already keeps onboarding answers and audit payloads.
 *
 * The vocabulary is deliberately the address row's own — `district`, not the `city` a
 * delivery view renames it to — so an order's recorded address and `/addresses` agree about
 * what an address is made of.
 */
export interface DeliveryAddressSnapshot {
  id: string;
  label: string;
  streetAddress: string;
  area: string;
  district: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
}

/** The fields a delivery address has that are worth keeping: exactly what a rider needs. */
export function snapshotDeliveryAddress(address: AddressRecord): DeliveryAddressSnapshot {
  return {
    id: address.id,
    label: address.label,
    streetAddress: address.streetAddress,
    area: address.area,
    district: address.district,
    postalCode: address.postalCode ?? '',
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null
  };
}

/**
 * Reads a stored snapshot back.
 *
 * A column left unreadable by a hand-edited database answers `null` rather than throwing: the
 * caller falls back to the live address, which is the best answer still available, and a read
 * of an old order never becomes a `500`.
 */
export function parseDeliveryAddressSnapshot(
  raw: string | null | undefined
): DeliveryAddressSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const source = parsed as Record<string, unknown>;
    if (typeof source.streetAddress !== 'string' || typeof source.label !== 'string') return null;

    return {
      id: typeof source.id === 'string' ? source.id : '',
      label: source.label,
      streetAddress: source.streetAddress,
      area: typeof source.area === 'string' ? source.area : '',
      district: typeof source.district === 'string' ? source.district : '',
      postalCode: typeof source.postalCode === 'string' ? source.postalCode : '',
      latitude: typeof source.latitude === 'number' ? source.latitude : null,
      longitude: typeof source.longitude === 'number' ? source.longitude : null
    };
  } catch {
    return null;
  }
}

export function parseNewAddress(body: Record<string, unknown>): NewAddressInput {
  const label = parseText(body.label, 'label', { min: 1, max: 40, required: false });
  const streetAddress = parseText(body.streetAddress, 'streetAddress', { min: 3, max: 200, required: true })!;
  const area = parseText(body.area, 'area', { min: 1, max: 80, required: true })!;
  const district = parseText(body.district, 'district', { min: 1, max: 80, required: true })!;
  const postalCode = parsePostalCode(body.postalCode) ?? '';
  const { latitude, longitude } = parseCoordinatePair(body);

  if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') {
    throw new ValidationError("Field 'isDefault' must be a boolean", { field: 'isDefault' });
  }

  return {
    label: label && label.length > 0 ? label : DEFAULT_ADDRESS_LABEL,
    streetAddress,
    area,
    district,
    postalCode,
    latitude,
    longitude,
    wantsDefault: body.isDefault === true
  };
}

export function parseAddressChanges(body: Record<string, unknown>): AddressChanges {
  const changes: AddressChanges = {};

  const label = parseText(body.label, 'label', { min: 1, max: 40, required: false });
  if (label !== undefined) changes.label = label;
  const streetAddress = parseText(body.streetAddress, 'streetAddress', { min: 3, max: 200, required: false });
  if (streetAddress !== undefined) changes.streetAddress = streetAddress;
  const area = parseText(body.area, 'area', { min: 1, max: 80, required: false });
  if (area !== undefined) changes.area = area;
  const district = parseText(body.district, 'district', { min: 1, max: 80, required: false });
  if (district !== undefined) changes.district = district;
  const postalCode = parsePostalCode(body.postalCode);
  if (postalCode !== undefined) changes.postalCode = postalCode;

  const latitude = parseCoordinate(body.latitude, 'latitude', 90);
  const longitude = parseCoordinate(body.longitude, 'longitude', 180);
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new ValidationError('latitude and longitude must be supplied together', {
      field: latitude === undefined ? 'latitude' : 'longitude'
    });
  }
  if (latitude !== undefined) changes.latitude = latitude;
  if (longitude !== undefined) changes.longitude = longitude;

  if (body.isDefault !== undefined) {
    if (typeof body.isDefault !== 'boolean') {
      throw new ValidationError("Field 'isDefault' must be a boolean", { field: 'isDefault' });
    }
    changes.wantsDefault = body.isDefault;
  }

  if (Object.keys(changes).length === 0) {
    throw new ValidationError(
      'Provide at least one of label, streetAddress, area, district, postalCode, latitude, longitude, isDefault',
      { field: 'body' }
    );
  }
  return changes;
}
