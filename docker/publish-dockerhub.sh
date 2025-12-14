#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法:
  DOCKERHUB_TOKEN=xxx ./docker/publish-dockerhub.sh

可选环境变量:
  DOCKERHUB_USERNAME   Docker Hub 用户名，默认: duegin
  DOCKERHUB_TOKEN      Docker Hub Token（推荐使用；不填则走交互式登录）
  IMAGE_REPO           镜像仓库名，默认: duegin/qinglong
  TAG                  镜像 tag，默认读取 version.yaml 的 version
  PUSH_LATEST          是否同时推送 latest，默认: 0 (不推送)。设为 1 推送
  PLATFORMS            buildx 多架构平台，默认: linux/amd64,linux/arm64
  DOCKERFILE           Dockerfile 路径，默认: ./Dockerfile

  BUILDER_NAME         buildx builder 名称，默认: qinglong-builder
  BUILDER_NETWORK      buildx builder 网络模式，默认: host
  FORCE_RECREATE_BUILDER  是否强制重建 builder，默认: 0。设为 1 可重建

  HTTP_PROXY           可选：为 buildx builder 注入代理
  HTTPS_PROXY          可选：为 buildx builder 注入代理
  NO_PROXY             可选：为 buildx builder 注入代理

  QL_URL               Dockerfile 内 git clone 的仓库地址；默认从 git remote origin 推导
  QL_BRANCH            Dockerfile 内 git clone 的分支名；默认当前 git 分支
  QL_MAINTAINER        镜像 maintainer label；默认: DOCKERHUB_USERNAME

示例:
  # 推送到 Docker Hub，并同时推送 latest
  DOCKERHUB_TOKEN=xxxxxxxx \
  PUSH_LATEST=1 \
  ./docker/publish-dockerhub.sh

  # 指定 tag / 指定分支(注意: Dockerfile 会从远程仓库 clone)
  TAG=2.19.2 QL_BRANCH=master ./docker/publish-dockerhub.sh
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[ERROR] 缺少命令: $1" >&2
    exit 1
  }
}

ensure_buildx_builder() {
  local builder_name="$1"
  local builder_network="$2"
  local force_recreate="$3"

  local need_recreate="0"

  if docker buildx inspect "$builder_name" >/dev/null 2>&1; then
    local inspect_out
    inspect_out="$(docker buildx inspect "$builder_name" 2>/dev/null || true)"

    if [[ "$inspect_out" != *"network=${builder_network}"* ]]; then
      need_recreate="1"
    fi

    if [[ -n "${HTTP_PROXY:-}" && "$inspect_out" != *"env.HTTP_PROXY"* ]]; then
      need_recreate="1"
    fi
    if [[ -n "${HTTPS_PROXY:-}" && "$inspect_out" != *"env.HTTPS_PROXY"* ]]; then
      need_recreate="1"
    fi
    if [[ -n "${NO_PROXY:-}" && "$inspect_out" != *"env.NO_PROXY"* ]]; then
      need_recreate="1"
    fi
  else
    need_recreate="1"
  fi

  if [[ "$force_recreate" == "1" || "$force_recreate" == "true" || "$force_recreate" == "yes" ]]; then
    need_recreate="1"
  fi

  if [[ "$need_recreate" == "1" ]]; then
    docker buildx rm "$builder_name" >/dev/null 2>&1 || true

    local -a driver_opts
    driver_opts=("--driver-opt" "network=${builder_network}")

    if [[ -n "${HTTP_PROXY:-}" ]]; then
      driver_opts+=("--driver-opt" "env.HTTP_PROXY=${HTTP_PROXY}")
    fi
    if [[ -n "${HTTPS_PROXY:-}" ]]; then
      driver_opts+=("--driver-opt" "env.HTTPS_PROXY=${HTTPS_PROXY}")
    fi
    if [[ -n "${NO_PROXY:-}" ]]; then
      driver_opts+=("--driver-opt" "env.NO_PROXY=${NO_PROXY}")
    fi

    docker buildx create \
      --name "$builder_name" \
      --driver docker-container \
      --use \
      --bootstrap \
      "${driver_opts[@]}" \
      >/dev/null
  else
    docker buildx use "$builder_name" >/dev/null
  fi
}

get_version_from_yaml() {
  if [[ -f "version.yaml" ]]; then
    awk -F': *' '/^version:/{print $2; exit}' version.yaml | tr -d '\r'
  fi
}

infer_git_origin_https() {
  local origin
  origin="$(git config --get remote.origin.url 2>/dev/null || true)"
  if [[ -z "$origin" ]]; then
    echo "https://github.com/whyour/qinglong.git"
    return
  fi

  # git@github.com:owner/repo.git -> https://github.com/owner/repo.git
  if [[ "$origin" =~ ^git@github.com:(.+)$ ]]; then
    echo "https://github.com/${BASH_REMATCH[1]}"
    return
  fi

  # https://github.com/owner/repo(.git) -> keep
  if [[ "$origin" =~ ^https?://github.com/ ]]; then
    echo "$origin"
    return
  fi

  # fallback: try to use as-is
  echo "$origin"
}

infer_git_branch() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
    echo "master"
  else
    echo "$branch"
  fi
}

infer_git_commit() {
  git rev-parse HEAD 2>/dev/null || echo "unknown"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_cmd docker
  require_cmd git

  if ! docker buildx version >/dev/null 2>&1; then
    echo "[ERROR] 未检测到 docker buildx。请先升级 Docker Desktop 或启用 buildx。" >&2
    exit 1
  fi

  local dockerhub_username
  dockerhub_username="${DOCKERHUB_USERNAME:-duegin}"

  local dockerfile platforms tag image_repo push_latest ql_url ql_branch ql_maintainer source_commit
  local builder_name builder_network force_recreate_builder

  dockerfile="${DOCKERFILE:-./Dockerfile}"
  platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
  push_latest="${PUSH_LATEST:-0}"

  tag="${TAG:-}"
  if [[ -z "$tag" ]]; then
    tag="$(get_version_from_yaml)"
  fi
  if [[ -z "$tag" ]]; then
    tag="$(date +%Y%m%d%H%M%S)"
  fi

  image_repo="${IMAGE_REPO:-duegin/qinglong}"

  builder_name="${BUILDER_NAME:-qinglong-builder}"
  builder_network="${BUILDER_NETWORK:-host}"
  force_recreate_builder="${FORCE_RECREATE_BUILDER:-0}"

  ql_url="${QL_URL:-$(infer_git_origin_https)}"
  ql_branch="${QL_BRANCH:-$(infer_git_branch)}"
  ql_maintainer="${QL_MAINTAINER:-${dockerhub_username}}"
  source_commit="${SOURCE_COMMIT:-$(infer_git_commit)}"

  if [[ ! -f "$dockerfile" ]]; then
    echo "[ERROR] 未找到 Dockerfile: $dockerfile" >&2
    exit 1
  fi

  echo "[INFO] 镜像仓库: ${image_repo}"
  echo "[INFO] tag: ${tag}"
  echo "[INFO] platforms: ${platforms}"
  echo "[INFO] Dockerfile: ${dockerfile}"
  echo "[INFO] build-args: QL_URL=${ql_url} QL_BRANCH=${ql_branch} SOURCE_COMMIT=${source_commit} QL_MAINTAINER=${ql_maintainer}"
  echo "[INFO] buildx builder: ${builder_name} (network=${builder_network})"

  echo "[INFO] 登录 Docker Hub..."
  if [[ -n "${DOCKERHUB_TOKEN:-}" ]]; then
    echo "$DOCKERHUB_TOKEN" | docker login -u "$dockerhub_username" --password-stdin
  else
    docker login -u "$dockerhub_username"
  fi

  ensure_buildx_builder "$builder_name" "$builder_network" "$force_recreate_builder"

  local -a tags
  tags=("--tag" "${image_repo}:${tag}")
  if [[ "$push_latest" == "1" || "$push_latest" == "true" || "$push_latest" == "yes" ]]; then
    tags+=("--tag" "${image_repo}:latest")
  fi

  echo "[INFO] 构建并推送..."
  docker buildx build \
    --builder "$builder_name" \
    --platform "$platforms" \
    --push \
    -f "$dockerfile" \
    --build-arg "QL_MAINTAINER=${ql_maintainer}" \
    --build-arg "QL_URL=${ql_url}" \
    --build-arg "QL_BRANCH=${ql_branch}" \
    --build-arg "SOURCE_COMMIT=${source_commit}" \
    "${tags[@]}" \
    .

  echo "[SUCCESS] 已推送: ${image_repo}:${tag}"
  if [[ "$push_latest" == "1" || "$push_latest" == "true" || "$push_latest" == "yes" ]]; then
    echo "[SUCCESS] 已推送: ${image_repo}:latest"
  fi
}

main "$@"
