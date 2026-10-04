export type VisualRegionDefinition = {
  selector: string
  closest?: string
  opacitySelectors?: readonly string[]
}

export function defineVisualRegions<const Regions extends Record<string, VisualRegionDefinition>>(regions: Regions) {
  return regions
}

export function mapVisualRegions<const Regions extends Record<string, VisualRegionDefinition>, Result>(
  regions: Regions,
  map: (region: Regions[keyof Regions], name: keyof Regions) => Result,
) {
  // SAFETY: entries come from the fixture-owned Regions dictionary, and mapping preserves every key exactly once.
  return Object.fromEntries(
    // SAFETY: Object.entries erases the generic value subtype, but each value belongs to the original Regions.
    Object.entries(regions).map(([name, region]) => [name, map(region as Regions[keyof Regions], name)]),
  ) as { [Name in keyof Regions]: Result }
}
