import Image from "next/image";

interface ChampionsGroupLogoProps {
  placement?: "header" | "login";
  priority?: boolean;
}

export function ChampionsGroupLogo({ placement = "header", priority = false }: ChampionsGroupLogoProps) {
  return (
    <Image
      src="/assets/champions-group-logo.png"
      alt="Champions Group"
      width={1410}
      height={779}
      priority={priority}
      className={`champions-group-logo ${placement}`}
    />
  );
}
