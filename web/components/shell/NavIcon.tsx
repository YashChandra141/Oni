// Tints a brand SVG with the current text color through a CSS mask.

export function NavIcon({ name, size = 16 }: { name: string; size?: number }) {
  const url = `url(/brand/icons/${name}.svg)`;
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 bg-current"
      style={{
        width: size,
        height: size,
        maskImage: url,
        WebkitMaskImage: url,
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskPosition: "center",
        WebkitMaskPosition: "center",
      }}
    />
  );
}
