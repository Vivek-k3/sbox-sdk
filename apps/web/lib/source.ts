import { loader } from "fumadocs-core/source";
import { createElement } from "react";

import { docs } from "@/.source/server";
import { PROVIDER_ICONS } from "@/lib/icons";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
  // Map an adapter page's `icon: <provider-id>` frontmatter to its logo so the
  // sidebar renders the brand mark next to each adapter entry.
  icon(name) {
    if (name && name in PROVIDER_ICONS) {
      return createElement(PROVIDER_ICONS[name]);
    }
  },
});
