import { ExternalLink } from "lucide-react";
import { apiPath } from "../lib/apiConfig";

const StatuteLink = ({
  href,
  fallbackHref,
  municipalityId,
  domainId,
  children,
}: {
  href?: string;
  fallbackHref?: string;
  municipalityId?: string;
  domainId?: string;
  children: React.ReactNode;
}) => {
  const statuteUrl =
    href ||
    fallbackHref ||
    (domainId && municipalityId ? apiPath(`statute/${domainId}/${municipalityId}`) : "#");

  return (
    <a
      href={statuteUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:text-blue-800 underline inline-flex items-center gap-1"
    >
      {children}
      <ExternalLink size={10} />
    </a>
  );
};

export default StatuteLink;
