# Stealth signer image (S8/S9). Build context = stealth-address/. CI-only build (.github/workflows/stealth-signer-image.yml).
# Code only: keys, TLS material and the RPC token are mounted at run time (KEYS_DIR, TLS_DIR, RPC_JWT_FILE), never copied in.
# Base pinned by digest (node:22-alpine index, resolved 2026-11-12); bump the digest deliberately.
FROM node@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY ts/bond.ts ts/chain.ts ts/memo.ts ts/stealth.ts ts/token.ts ts/
COPY signer/src signer/src
# Image content check: node >=22.18 (engines) and no key-like file may be in the image.
RUN node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<18))process.exit(1)' \
 && ! find /app -path /app/node_modules -prune -o -type f \( -iname '*.pem' -o -iname '*.key' -o -iname '*.p12' -o -iname '*.pfx' -o -iname '*.jks' -o -iname '.env*' -o -name spendKey -o -name viewKey -o -name identityKey -o -name certKey \) -print | grep -q .
USER 10001
ENV NODE_ENV=production
# server.ts uses parameter properties, which strip-only mode rejects (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX): transform-types is required.
CMD ["node", "--experimental-transform-types", "signer/src/main.ts"]
