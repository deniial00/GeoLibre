const CREDENTIAL_QUERY_KEYS: Record<string, true> = {
  token: true,
  access_token: true,
  api_key: true,
  apikey: true,
  key: true,
  signature: true,
  password: true,
  secret: true,
};

function hasPluginWfsCredentials(url: URL): boolean {
  return (
    url.username !== "" ||
    url.password !== "" ||
    [...url.searchParams].some(
      ([key, value]) => value !== "" && CREDENTIAL_QUERY_KEYS[key.toLowerCase()] === true,
    )
  );
}

/** Validate a plugin WFS destination before either a browser or native request. */
export function validatePluginWfsUrl(target: URL): void {
  const host = target.hostname.toLowerCase();
  const credentials = hasPluginWfsCredentials(target);
  const localHost =
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  if (credentials && target.protocol !== "https:" && !(target.protocol === "http:" && localHost)) {
    throw new Error("addWfsLayer: credentials require HTTPS (or HTTP localhost).");
  }
  if (localHost && target.protocol === "http:") return;
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(
      "addWfsLayer: URL must target a public destination (or unauthenticated localhost).",
    );
  }
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    if (mapped) {
      const octets = mapped[1].split(".").map(Number);
      if (isPrivateIpv4Literal(octets)) {
        throw new Error(
          "addWfsLayer: URL must target a public destination (or unauthenticated localhost).",
        );
      }
      return;
    }
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(bare);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      if (isPrivateIpv4Literal([(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255])) {
        throw new Error(
          "addWfsLayer: URL must target a public destination (or unauthenticated localhost).",
        );
      }
      return;
    }
    if (
      bare === "::" ||
      bare === "::1" ||
      /^f[cd][0-9a-f]{2}:/i.test(bare) ||
      /^fe[89ab][0-9a-f]:/i.test(bare) ||
      /^2002:/i.test(bare) ||
      /^2001:0:/i.test(bare) ||
      /^2001:(?:0db8|0010|0002):/i.test(bare) ||
      /^::[0-9a-f.]+$/i.test(bare)
    ) {
      throw new Error(
        "addWfsLayer: URL must target a public destination (or unauthenticated localhost).",
      );
    }
    return;
  }
  const octets = bare.split(".").map(Number);
  if (octets.length === 4 && isPrivateIpv4Literal(octets)) {
    throw new Error(
      "addWfsLayer: URL must target a public destination (or unauthenticated localhost).",
    );
  }
}

function isPrivateIpv4Literal(octets: number[]): boolean {
  if (
    octets.length !== 4 ||
    !octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    return true;
  }
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
