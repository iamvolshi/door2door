# Attic — working code with no callers

These modules compiled and were internally consistent, but on 2026-10-14 a
whole-codebase reference sweep proved **zero importers** for every export in
each file — nothing in `src/`, `tests/`, `test/`, or `scripts/` imports them,
and `src/index.ts` does not re-export them. They are roadmap code for unbuilt
product (category rollout, revenue/pricing engine), parked here so the build
stays lean and readers stop mistaking them for the live path.

- `categoryManager.ts` + `categoryTypes.ts` (317 + 71 lines) — service-category
  rollout engine. Nothing uses it.
- `pricingEngine.ts` + `revenueTypes.ts` + `revenueConfig.ts` (221 + 134 + 187
  lines) — revenue/pricing engine. The live fare path is
  `src/services/pricingService.ts` (covered by `test/pricing-idempotency.spec.ts`);
  this is a separate, unwired engine.

This directory is **outside `tsconfig.json` (`src/**/*`) and vitest**, so
nothing here is compiled or tested. Keep it that way: do not import from
`attic/` — move a file back into `src/` first.

Restore (example):

```bash
mkdir -p src/modules/categories
mv attic/categoryManager.ts attic/categoryTypes.ts src/modules/categories/
npm run build && npm test
```
