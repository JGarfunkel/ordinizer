import { useEffect } from "react";
import type { RealmOgMeta } from "@civillyengaged/ordinizer-core";

const OG_PROPERTY_PREFIX = "og:";

/** Upserts <meta property="og:*"> tags in <head> from a realm's ogMeta overrides. */
export function useOgMeta(ogMeta?: RealmOgMeta | null) {
  useEffect(() => {
    if (!ogMeta) return;

    const managedTags: HTMLMetaElement[] = [];
    for (const [property, content] of Object.entries(ogMeta)) {
      if (!content) continue;
      const propertyName = `${OG_PROPERTY_PREFIX}${property}`;
      let tag = document.head.querySelector<HTMLMetaElement>(`meta[property="${propertyName}"]`);
      const preexisting = !!tag;
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("property", propertyName);
        document.head.appendChild(tag);
      }
      tag.setAttribute("content", content);
      if (!preexisting) managedTags.push(tag);
    }

    return () => {
      managedTags.forEach(tag => tag.remove());
    };
  }, [ogMeta]);
}
