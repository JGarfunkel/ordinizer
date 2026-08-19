import { ExternalLink } from "lucide-react";
import { apiPath } from "../lib/apiConfig";

const SourceLink = ({
  href,
  fallbackHref,
  realmId,
  entityId,
  domainId,
  children,
}: {
  href?: string;
  fallbackHref?: string;
  realmId?: string;
  entityId?: string;
  domainId?: string;
  children: React.ReactNode;
}) => {
  const fallbackUrl =
    domainId && entityId
      ? `${apiPath(`statute/${domainId}/${entityId}`)}${realmId ? `?realm=${encodeURIComponent(realmId)}` : ""}`
      : undefined;
  const sourceUrl = href || fallbackHref || fallbackUrl;

  // No usable target: render as plain text instead of a dead "#" link.
  if (!sourceUrl) {
    return <>{children}</>;
  }

  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-blue-800 underline inline-flex items-center gap-1"
    >
      {children}
      <ExternalLink size={10} />
    </a>
  );
};

export default SourceLink;
