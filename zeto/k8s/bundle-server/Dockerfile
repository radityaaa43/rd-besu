# Image for --sink-image (zeto S17): python3 + the sink + the opa binary the sink signs with. Build context = the repo root:
#   docker build -f zeto/k8s/bundle-server/Dockerfile -t <registry>/bundle-server:<tag> .   (pin the pushed digest in --sink-image)
FROM openpolicyagent/opa:1.21.1-static AS opa
FROM python:3.12-alpine
COPY --from=opa /opa /usr/local/bin/opa
COPY opa/bundle-server/sink.py /app/sink.py
USER 10001
