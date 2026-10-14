import { ValidationError } from '../core/errors';
import { serviceAreaManager } from '../modules/areas/serviceAreaManager';
import type { ServiceArea } from '../modules/areas/areaTypes';

/**
 * Where the platform will deliver, asked in one place.
 *
 * `ServiceAreaManager` (src/modules/areas/serviceAreaManager.ts) already knows the ten pilot
 * zones — their bounding boxes, the nearest-centre fallback it applies outside them, and whether
 * a zone is taking work at all — and until now it had no caller: every zone was seeded in memory
 * at boot and consulted by nothing, so an address saved anywhere on earth was as acceptable as
 * one in Kolatoli, and the fleet's reach was a fact only the map knew.
 *
 * This module is that caller, and it stays thin on purpose. The rule is *asked* rather than
 * reimplemented, so a zone that is suspended, restricted or redrawn changes what is accepted
 * here without anything being edited twice — the same reason a delivery address is served
 * through `maskAddress` rather than serialized again beside it.
 */

export interface CoverageVerdict {
  /** True when the platform will deliver to this point. */
  deliverable: boolean;
  /** The zone the point falls in, when it falls in one at all. */
  area: ServiceArea | null;
  /**
   * The zone's own words. For a point that is refused, why it is refused; for one that is
   * served under restrictions, which restrictions. Empty for an ordinary zone.
   */
  reason: string;
}

/**
 * The platform's answer for one coordinate, without deciding anything for it.
 *
 * `verifyDeliveryAvailability` is the whole rule: a bounding box, then the nearest centre within
 * its 25 km radius, then the zone's status. A zone that is `RESTRICTED` is **served** — the
 * manager answers `isDeliverable: true` with the restrictions beside it, which is what Saint
 * Martin's maritime courier window is — and only `INACTIVE` (suspended) and "no zone at all"
 * come back undeliverable.
 */
export function checkDeliveryCoordinates(latitude: number, longitude: number): CoverageVerdict {
  const verdict = serviceAreaManager.verifyDeliveryAvailability({
    coordinates: { latitude, longitude }
  });

  return {
    deliverable: verdict.isDeliverable,
    area: verdict.area ?? null,
    reason: verdict.reasons.join(' ')
  };
}

/**
 * Refuses a delivery coordinate the fleet does not serve.
 *
 * `400` and not `403`: nothing about the caller is wrong — the point is simply somewhere the
 * platform does not go — and the reply separates the two ways that happens, because they mean
 * different things to a customer: a point in a zone that has been suspended names the zone,
 * while a point in no zone at all says so and lists what is registered.
 *
 * The `field` is `latitude` because that is the first input a form highlights, and the pair is
 * carried explicitly rather than implied, so a client can show the address it refused. Callers
 * run this before their write, so a refused address leaves no row behind and does not disturb
 * the default it would otherwise have taken.
 */
export function assertDeliverableCoordinates(
  latitude: number,
  longitude: number
): CoverageVerdict {
  const verdict = checkDeliveryCoordinates(latitude, longitude);
  if (verdict.deliverable) return verdict;

  const where = `(${latitude}, ${longitude})`;
  const registered = serviceAreaManager
    .getAllAreas()
    .map((area) => area.name)
    .join(', ');

  throw new ValidationError(
    verdict.area
      ? `Delivery to ${where} is not available: ${verdict.reason}`
      : `Delivery to ${where} is outside every serviced area. Registered zones: ${registered}.`,
    {
      field: 'latitude',
      latitude,
      longitude,
      // The zone it landed in, or null when it landed in none: "we do not go there" and "we are
      // not going there this week" are different answers, and a client should not have to parse
      // the message to tell them apart.
      serviceArea: verdict.area?.code ?? null,
      reason: verdict.reason
    }
  );
}
