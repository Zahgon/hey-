# Port of the Go Dockerfile.
#
# The Go original used a two-stage build ending in `scratch`, which a static Go
# binary allows. Node needs its runtime, so the final stage is a distroless
# Node image instead. There is nothing to compile, so there is no build stage.
FROM gcr.io/distroless/nodejs22-debian12

ARG APPLICATION="hey"
ARG DESCRIPTION="HTTP load generator, ApacheBench (ab) replacement, formerly known as rakyll/boom"
ARG PACKAGE="rakyll/hey"

LABEL org.opencontainers.image.ref.name="${PACKAGE}" \
    org.opencontainers.image.authors="Jaana Dogan <@rakyll>" \
    org.opencontainers.image.documentation="https://github.com/${PACKAGE}/README.md" \
    org.opencontainers.image.description="${DESCRIPTION}" \
    org.opencontainers.image.licenses="Apache 2.0" \
    org.opencontainers.image.source="https://github.com/${PACKAGE}"

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin

USER nonroot:nonroot
ENTRYPOINT ["/nodejs/bin/node", "/app/bin/hey.js"]
