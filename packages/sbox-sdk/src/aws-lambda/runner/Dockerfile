# Reference MicroVM image for the sbox-sdk AWS Lambda MicroVMs adapter.
# Build -> zip with this Dockerfile + server.mjs -> upload to S3 ->
# CreateMicrovmImage (see ./README.md). The runner runs INSIDE the isolated
# MicroVM; executing arbitrary commands is its purpose (that is what the sandbox
# is for), and it is never exposed on the host.
FROM public.ecr.aws/docker/library/node:22-slim

WORKDIR /opt/sbox
COPY server.mjs .

# The MicroVM endpoint routes to port 8080 by default.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "/opt/sbox/server.mjs"]
