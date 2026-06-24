ARG TARGETPLATFORM=linux/amd64
FROM --platform=$TARGETPLATFORM ubuntu:24.04

ARG AUDIVERIS_VERSION=5.10.2
ARG AUDIVERIS_DEB=Audiveris-${AUDIVERIS_VERSION}-ubuntu24.04-x86_64.deb

ENV DEBIAN_FRONTEND=noninteractive
ENV AUDIVERIS_BIN=/usr/bin/audiveris
ENV PORT=8080

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fontconfig \
    fonts-dejavu-core \
    libasound2t64 \
    libbsd0 \
    libmd0 \
    libx11-6 \
    libxau6 \
    libxcb1 \
    libxdmcp6 \
    libxext6 \
    libxi6 \
    libxrender1 \
    libxtst6 \
    nodejs \
    npm \
    zlib1g \
  && curl -fsSL "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/${AUDIVERIS_DEB}" -o /tmp/audiveris.deb \
  && dpkg-deb -x /tmp/audiveris.deb / \
  && fc-cache -f \
  && sed -i 's/java-options=-Xmx8G/java-options=-Xmx1536M/' /opt/audiveris/lib/app/Audiveris.cfg \
  && ln -s /opt/audiveris/bin/Audiveris /usr/bin/audiveris \
  && rm -rf /tmp/audiveris.deb /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.mjs ./

EXPOSE 8080
CMD ["npm", "start"]
