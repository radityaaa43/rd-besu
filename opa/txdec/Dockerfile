# txdec sidecar of the Iroha 3 gateways: `rd-dfabi decode-tx serve`, built with --features decode in the private repo
# radityaaa43/iroha3-rd-dfabi-build (CI artifact rd-dfabi-decode). Build context = a directory holding that binary:
#   gh run download <run> -R radityaaa43/iroha3-rd-dfabi-build -n rd-dfabi-decode -D ctx && cp Dockerfile ctx/
#   docker build -t ghcr.io/radityaaa43/rd-dfabi-decode:<sha12 of binary> ctx && docker push ... (package stays PRIVATE)
# The binary needs glibc >= 2.34 (checked on the aps build); bookworm has 2.36. bash is for the readiness probe.
FROM debian:bookworm-slim
RUN useradd -u 10001 -m -d /home/txdec txdec
COPY rd-dfabi-decode /usr/local/bin/rd-dfabi
RUN chmod 755 /usr/local/bin/rd-dfabi
USER 10001
