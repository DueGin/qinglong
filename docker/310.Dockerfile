FROM python:3.10-alpine3.18 AS builder

ENV QL_DIR=/ql

WORKDIR ${QL_DIR}

RUN set -x \
  && apk add --no-cache nodejs npm git build-base \
  && npm i -g pnpm@8.3.1 pm2 ts-node \
  && git config --global http.version HTTP/1.1

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN set -x \
  && cp -f .env.example .env \
  && chmod 777 ${QL_DIR}/shell/*.sh \
  && chmod 777 ${QL_DIR}/docker/*.sh \
  && pnpm run build:front \
  && pnpm run build:back \
  && pnpm prune --prod \
  && rm -rf ${QL_DIR}/.git

FROM python:3.10-alpine

LABEL maintainer="whyour"

ENV QL_DIR=/ql \
  QL_BRANCH=develop \
  LANG=C.UTF-8 \
  SHELL=/bin/bash \
  PS1="\u@\h:\w \$ "

VOLUME /ql/data
  
EXPOSE 5700

COPY --from=builder /usr/local/lib/node_modules/. /usr/local/lib/node_modules/
COPY --from=builder /usr/local/bin/. /usr/local/bin/

RUN set -x \
  && apk update -f \
  && apk upgrade \
  && apk --no-cache add -f bash \
  coreutils \
  git \
  curl \
  wget \
  tzdata \
  perl \
  openssl \
  nodejs \
  jq \
  openssh \
  procps \
  netcat-openbsd \
  unzip \
  npm \
  && rm -rf /var/cache/apk/* \
  && apk update \
  && ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && git config --global user.email "qinglong@users.noreply.github.com" \
  && git config --global user.name "qinglong" \
  && git config --global http.postBuffer 524288000 \
  && rm -rf /root/.cache \
  && ulimit -c 0

COPY --from=builder ${QL_DIR} ${QL_DIR}

ENV PNPM_HOME=${QL_DIR}/data/dep_cache/node \
  PYTHON_HOME=${QL_DIR}/data/dep_cache/python3 \
  PYTHONUSERBASE=${QL_DIR}/data/dep_cache/python3

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PNPM_HOME}:${PYTHON_HOME}/bin \
  NODE_PATH=/usr/local/bin:/usr/local/lib/node_modules:${PNPM_HOME}/global/5/node_modules \
  PIP_CACHE_DIR=${PYTHON_HOME}/pip \
  PYTHONPATH=${PYTHON_HOME}:${PYTHON_HOME}/lib/python3.10:${PYTHON_HOME}/lib/python3.10/site-packages

RUN pip3 install --prefix ${PYTHON_HOME} requests

WORKDIR ${QL_DIR}

HEALTHCHECK --interval=5s --timeout=2s --retries=20 \
  CMD curl -sf --noproxy '*' http://127.0.0.1:5700/api/health || exit 1

ENTRYPOINT ["./docker/docker-entrypoint.sh"]
