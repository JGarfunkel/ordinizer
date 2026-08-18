import type { Entity, EntityLink, EntityLinkType } from "@civillyengaged/ordinizer-core";

const ENTITY_LINK_FALLBACK: Record<EntityLinkType, keyof Entity> = {
  main: "mainUrl",
  governing: "governingUrl",
  hub: "hubUrl",
  authority: "authorityUrl",
};

/**
 * Resolves an entity's URL for the given link type, preferring the `links`
 * array/map and falling back to the deprecated flat fields (`mainUrl`, etc.)
 * for entities that haven't been migrated yet.
 */
export function getEntityLink(entity: Entity, type: EntityLinkType): string | undefined {
  const links = entity.links as EntityLink[] | Record<string, string> | undefined;
  if (Array.isArray(links)) {
    const fromLinks = links.find((l) => l.type === type)?.url;
    if (fromLinks) return fromLinks;
  } else if (links && typeof links === "object") {
    // Future format: links is a plain object keyed by link type, e.g. { governing: "https://..." }
    const fromLinks = links[type];
    if (fromLinks) return fromLinks;
  }
  return entity[ENTITY_LINK_FALLBACK[type]] as string | undefined;
}
