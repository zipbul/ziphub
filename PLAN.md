# ziphub 최종 플랜 (v5, 라운드 4 리뷰 반영)

> v4의 BLOCKER 2건 (네트워크 격리·cross-daemon 볼륨) 수술적 수정. 핵심 변경:
> (a) **`ziphub-server`도 `agent-net`에 참여** — 에이전트가 서버에 도달 가능 (이전엔 격리)
> (b) **gate-controller 폐기, host docker daemon 직접 사용** — cross-daemon 볼륨 문제 해소
> (c) **docker-socket-proxy 사이드카** (Tecnativa) — 서버에 host docker.sock 직접 노출 안 하고 화이트리스트된 API만 노출
> (d) **§20에 `privileged` + dind 트레이드오프 명시** 폐지 (gate-controller 자체 폐기)
> (e) MINOR 정리 (`--no-verify=false` 제거, `NO_PROXY` glob 명시화)
>
> v3 → v4에서 적용된 변경들은 모두 유지 (트레일러·squid·proxy 환경변수·additive trust·cold_start 정의 등).

---

## 0. 목표·비목표·SLO·수용 리스크

### 목표
- `/home/revil/projects/zipbul` 아래 12개 서브 레포 각각에 A2A 에이전트를 심고 중앙 `ziphub`이 관찰·조정·정책 집행
- **인간 최소 개입 바이브코딩 자동화**

### 비목표
- 멀티 사용자·테넌시·원격 배포·에이전트 자동 레포 생성·LLM 파인튜닝

### SLO
- **자동 머지는 로컬 브랜치 머지만**. `git push`는 사람만.
- **개입 큐**: 항목 48h 미응답 → 해당 에이전트 `paused`. 진행 중 Task 파괴·롤백 없음.
- **revert SLO**: 자동 머지 변경의 주간 revert율 > 10% → 전역 `auto-green` 자동 비활성화. UI 빨간 배너.
- **Spend 한도**: 전역 일일 + 에이전트별 시간당. 초과 즉시 `control.shutdown`.
- **localhost-only**: 서버는 `127.0.0.1:3000`만 바인드.

### 수용 리스크
- 의미론적 버그가 결정적 게이트 통과 가능 → outcome 피드백·revert 감지·신뢰 점수
- 프롬프트 인젝션·LLM 탈옥 → §20 격리·권한 최소화로 영향 한정
- Postgres 단독 → 병목 시 NATS 이전 가능
- JWT revocation 잔여 윈도우 (~1초) — 즉시 close + 캐시로 최소화, 0초 불가

---

## 1. 대상 레포와 내부 의존

**레포 12개**: `agent-rules`, `baker`, `blazewrit`, `emberdeck`, `firebat`, `gildash`, `knoldr`, `pyreez`, `toolkit`, `toolkit-cookie`, `toolkit-helmet`, `zipbul`

**내부 의존**: `@zipbul/result`(외부 npm) → `baker`, `gildash`. `gildash` → `emberdeck`, `firebat`.
롤아웃 순서: `gildash` → `baker` → `emberdeck`/`firebat` → 나머지.

---

## 2. 아키텍처 개요

```
┌──────────────── docker compose (127.0.0.1:3000만 노출) ──────────────┐
│  postgres:17        상태·이벤트·락·KV·감사 SoT                       │
│  ziphub-server      Bun, API, WS, 프로젝터, 정책, 워치독, 게이트 오케 │
│  egress-proxy       squid, SNI allowlist (LLM/npm/GitHub)            │
│  docker-proxy       Tecnativa docker-socket-proxy (게이트 spawn 전용)│
│  agent-{repo} ×12   userns-remap, /repo bind, egress-proxy 강제      │
│                                                                       │
│  네트워크: control-net(에이전트↔서버), egress-net(서버·proxy↔외부)   │
│  agent ←─ JWT ──→ ziphub-server (WS, control-net)                     │
│  agent ←─ A2A direct (control-net, JWT 자체검증) ──→ agent            │
│  서버 ──→ docker-proxy ──→ host dockerd (게이트 컨테이너 spawn)       │
└───────────────────────────────────────────────────────────────────────┘
```

### 불변 원칙
- 1 에이전트 : 1 레포 : 1 컨테이너
- 모든 외부 HTTPS는 egress-proxy 경유 (`HTTPS_PROXY` + `BUN_CONFIG_HTTPS_PROXY` + `npm_config_https_proxy` + `git http.proxy`)
- 서버만 Postgres LISTEN, 에이전트는 WS 경유
- 서버는 `127.0.0.1:3000`만
- 게이트 러너는 host dockerd에서 spawn (volume·namespace 통일). 단 서버는 host docker.sock을 직접 마운트하지 않고 **`docker-proxy` 사이드카** (Tecnativa docker-socket-proxy)를 통해 화이트리스트된 API만 호출 (`POST /containers/create`, `/containers/{id}/start`, `/containers/{id}/wait`, `DELETE /containers/{id}`만 허용. `/exec`·`/info`·`HostConfig.Privileged=true`는 거부).

### 모노레포 패키지
```
ziphub/
├── packages/{shared, server, ui, agent-core, agent-exec, agent-a2a, agent-runtime}
├── docker/
│   ├── server.Dockerfile
│   ├── agent.Dockerfile
│   ├── docker-proxy-guard.Dockerfile  # Bun mini-proxy (Tecnativa 앞단, body 검사)
│   ├── gate-runner.Dockerfile
│   ├── egress-proxy.Dockerfile        # squid 베이스
│   ├── squid.conf                     # SNI ACL
│   ├── seccomp.json
│   └── allowlist.txt
├── docker-compose.yml
├── docker-compose.agents.yml          # 자동 생성
├── scripts/
│   ├── preflight.sh                   # daemon.json·userns-remap 점검
│   ├── rollout-agents.ts
│   └── seed-agent-trust.ts            # M5/테스트용
└── PLAN.md
```

---

## 3. 프로토콜

### 3.1 등록 (HTTP, 1회)

```
POST /api/agents/register
Body: AgentCard {
  id, repoName, url ("http://agent-baker:4000"),
  version, capabilities[], publicKey
}
200: { agentToken, hubPublicKey, directory[], policy, wsUrl }
```
- 토큰 발급은 hub 단독. 에이전트 공개키는 식별·옵션 페이로드 서명용
- 서버는 등록 직후 `url`로 `GET /.well-known/agent` 콜백 → 실패 시 거부
- `/api/agents/register`는 fail-closed의 유일한 사전 허용 호출 (네트워크 layer가 아닌 tool API layer 의미, §7 참조)

### 3.2 WebSocket

- `Authorization: Bearer <agentToken>` 필수
- 메시지 형식: `{ seq, agentId, ts, type, payload, idempotencyKey }`
- `seq`: agent별 단조증가, 로컬 저널 영속

**에이전트 → 서버**: heartbeat(20s), task.event, task.progress, task.artifact.meta, task.log.tick, peer.call.{start,end,received,responded,progress}, input.request, spend.report, repo.dirty
**서버 → 에이전트**: directory.update(revocation 델타 포함), input.response, control.{cancel,shutdown,pause,resume}, policy.update, ackSeq, flow.{pause,resume}

### 3.3 Task 상태기계 + 머지 리콘실리에이션

**상태기계**
```
queued → claimed → working → gated → {merged | review-required | failed | canceled}
                               ↑
   input-required ─────────────┘
```
모든 전이 낙관적. ack-wait 없음. 누적 `ackSeq`만 통지.

**Idempotency**: `(agentId, taskId, localSeq)`, DB `UNIQUE(agent_id, idempotency_key)`.

#### 머지 절차 (강화, NEW v3 #1~#4)

머지는 **에이전트 컨테이너**에서 실행 (자기 레포 rw mount 보유).

```bash
# 1. 작업 브랜치 검증
git diff --cached --quiet || abort           # 인덱스 비어있어야 함
[[ -f .git/index.lock ]] && abort            # lock 존재 시 중단

# 2. main 체크아웃 (clean 보장)
git checkout main
git status --porcelain | grep -q . && abort  # 워킹트리 dirty면 중단

# 3. squash merge 시도
git merge --squash ziphub/task-${taskId}
# --squash는 인덱스에 변경 stage하지만 commit 안 함
# 충돌 발생 시 working tree에 conflict marker 남음

# 4. 충돌 검증
if [[ -n "$(git ls-files -u)" ]]; then
  # unmerged paths 존재 → 충돌
  git merge --abort 2>/dev/null || true
  git reset --hard HEAD                       # working tree 정리
  emit 'task.event { type: review-required, reason: merge-conflict }'
  exit
fi

# 5. 변경이 실제 있는지 확인
if git diff --cached --quiet; then
  # 변경 없음 = no-op merge
  emit 'task.event { type: merged, sha: HEAD, noop: true }'
  exit
fi

# 6. trailer를 --trailer 옵션으로 안전하게 추가
#    (commit-msg 훅이 메시지를 재작성하더라도 trailer는 보존됨)
git commit \
  --trailer "Ziphub-Task-Id=${taskId}" \
  --trailer "Ziphub-Agent=${agentId}" \
  -m "${shortSummary}"

# 7. trailer 실제 보존 검증 (훅이 strip 했을 가능성)
sha=$(git rev-parse HEAD)
if ! git interpret-trailers --parse <(git log -1 --format='%B' "$sha") \
       | grep -Fxq "Ziphub-Task-Id: ${taskId}"; then
  # 훅이 trailer 제거 → 즉시 revert + repo.dirty
  git reset --hard HEAD~1
  emit 'task.event { type: review-required, reason: trailer-stripped }'
  emit 'repo.dirty { reason: commit-msg-hook-strips-trailer }'
  exit
fi

# 8. 머지 성공 선언 (낙관적)
emit 'task.event { type: merged, sha: '$sha' }'
```

#### 리콘실리에이션 (서버·에이전트 부팅 시)

서버:
```bash
# fixed-string grep + trailer parse로 안전한 매치
sha=$(git -C /repo log main --grep="Ziphub-Task-Id: ${taskId}" --fixed-strings -n 1 --format='%H')
if [[ -n "$sha" ]]; then
  parsed=$(git -C /repo log -1 --format='%B' "$sha" | git -C /repo interpret-trailers --parse)
  if echo "$parsed" | grep -Fxq "Ziphub-Task-Id: ${taskId}"; then
    state = 'merged'
  fi
fi
state = 'review-required' (no trailer match)
```

에이전트는 fs/repo 상태가 깨끗하면 task가 review-required로 가도 정상 (단순 false negative).

#### `commit-msg` 훅 정책
- ziphub 관리 레포는 `commit-msg`/`prepare-commit-msg` 훅이 trailer를 제거해선 안 됨
- 에이전트 부팅 시 점검 스크립트:
  ```bash
  for h in commit-msg prepare-commit-msg; do
    if [[ -x .git/hooks/$h ]]; then
      echo "Test trailer preservation"
      ...
    fi
  done
  ```
- 점검 실패 시 `repo.dirty` + `paused`로 시작 → 사람이 훅 수정

### 3.4 A2A 브릿지

ziphub Task ≠ A2A Task. 명시 분리.
- A → B A2A 호출 시 A는 ziphub child task 생성, A2A 메타에 `ziphub.{taskId,traceId,parentTaskId}` 확장 필드
- B의 `agent-a2a`가 수신 → ziphub task 레코드에 `a2aTaskId` 바인딩 + `claimed` 발행
- `tasks.a2a_task_id` 컬럼 보관, `trace_id`는 루트에서 발급·전파

---

## 4. 데이터 모델 (Postgres 17)

핵심 테이블 스키마는 v3과 동일 (지면상 생략, 변경분만 명시):

```sql
-- v3과 동일: agents, tasks, task_events(월별 파티션), idempotency_acks,
--           peer_calls, locks, policies, spend(provider 차원), audit(월별 파티션),
--           outcomes, agent_trust

-- 추가/수정
CREATE TABLE token_revocations (
  agent_id text NOT NULL,
  token_kid text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,    -- = original_token_exp + 30s (peer cache TTL)
  reason text,
  PRIMARY KEY (agent_id, token_kid)
);
CREATE INDEX ON token_revocations (expires_at);

-- 워치독이 expires_at < now() 행 자동 삭제
-- directory.update는 (revoked_at > $client_lastSeen) 델타만 전송
```

### 메시징·보존
- pub/sub: `LISTEN ziphub_events` + `NOTIFY` (페이로드 (created_at, id) 튜플)
- catch-up: `WHERE (created_at, id) > ($cur) AND created_at < now() - interval '2 seconds'`
- 락: `pg_advisory_xact_lock(hashtextextended(key, 0))` + `locks` 테이블
- 보존: `task_events` 90일, `audit` 365일, `peer_calls` 90일, `task.log` 파일 30일 (완료 task만)
- 연결 풀: 서버 LISTEN 1 + pool 10. 에이전트는 직접 연결 안 함

### `agents` 테이블 스키마 (재명시, NEW v3 #21)
```sql
CREATE TABLE agents (
  id text PRIMARY KEY,                  -- "agent:baker"
  repo_name text NOT NULL UNIQUE,
  url text NOT NULL,
  version text,
  capabilities jsonb,
  status text NOT NULL CHECK (status IN ('active','stale','paused','shutdown')),
  public_key text NOT NULL,
  token_kid text,
  last_heartbeat_at timestamptz,
  registered_at timestamptz DEFAULT now()
);
```

---

## 5. 품질 게이트

### 파이프라인
1. 빌드 (bun run build)
2. 타입체크 (tsc --noEmit)
3. 린트 (oxlint)
4. 테스트 (bun test)
5. 커버리지 (≥ 70% 기본)
6. 리뷰 에이전트 (advisory)

### 게이트 러너 컨테이너 (v5 — host dockerd 사용)

- 베이스 이미지: agent와 동일 권한 모델 (cap_drop ALL, read-only root, seccomp, userns-remap)
- 호출: ziphub-server가 `docker-proxy`를 통해 host dockerd에 `containers/create` + `containers/start` 요청 → 게이트 컨테이너는 **host docker daemon 위에서 실행** (volume·namespace가 agent와 일치)
- **node_modules 정책**: agent의 명명 볼륨(`agent-baker-node_modules`)을 게이트에 **`ro`로 마운트** (host docker가 같은 데몬이라 직접 마운트 가능)
  - lockfile 변경한 pr-green 게이트는 자체 ephemeral 볼륨에 `bun install --ignore-scripts`로 재구성, 게이트 종료 시 폐기
- 게이트는 `docker-proxy`에 자기 자신 권한이 없음 (proxy는 서버 신원만 허용) → 게이트 안에서 docker API 접근 불가
- 결과: `state` 명명 볼륨의 `/state/gate/{runId}/result.json` 작성 (volume도 host dockerd 소유라 게이트가 직접 마운트)
- 게이트 종료 후 컨테이너 자동 제거 (`AutoRemove: true`)

### 재시도·서킷 브레이커
- per-task 3회 하드캡 (실패 종류 무관, 카운터 리셋 없음)
- 3회 소진 → `review-required`
- 글로벌: 1h 게이트 실패율 30% → 신규 Task 정지

### 레포별 설정 (`{repo}/ziphub.config.ts`)
```ts
export default {
  gates: {
    build: "bun run build",
    typecheck: "tsc --noEmit",
    lint: "bun x oxlint .",
    test: "bun test",
    coverageThreshold: 70
  },
  riskOverrides: { /* §6 */ }
};
```

---

## 6. 위험도 기반 머지

| 등급 | 조건 (전부 AND) |
|---|---|
| **auto-green** | 결정적 게이트 전부 통과 / 변경 경로 전부 `[docs, examples, README*, *.md]` (테스트 제외) / `max(added, deleted) ≤ 50` LOC / `package.json`·lockfile·`tsconfig*`·`bunfig.toml`·`.github/**` 무수정 / 삭제 파일 없음 / 신뢰 점수 ≥ 0.7 AND `cold_start=false` / `commit-msg` 훅 점검 통과 |
| **pr-green** | 결정적 게이트 통과 + auto-green 미달 |
| **never-auto** | 경로: `migrations/**`, `auth/**`, `security/**`, `.github/**`, `Dockerfile*`, `docker-compose*`, `bunfig.toml`, `tsconfig*`, `.env*`, 암호화 |

### Cold-start 게이트 (NEW v3 #11 명확화)
- 신규 에이전트 `cold_start=true` → pr-green만 가능
- **"pr-green 5회 연속 성공"의 정의**: 사람 승인 + 머지 + **24h 내 revert 미감지**
- 5회 연속 성공 시 `cold_start=false`, 이후 신뢰 점수 조건과 AND
- 1회라도 revert 발생 → 카운터 리셋

### 자동 머지 = 로컬만
§3.3 머지 절차 참조. `tools.git.*`에 push 함수 없음 + egress-proxy가 git remote URL 차단 (이중 안전).

### 글로벌 revert SLO
주간 auto-green revert율 > 10% → `policy.global.autoGreenDisabled=true` 자동.

---

## 7. 정책 엔진

### 정책 구조
```ts
type Policy = {
  version: number;
  global: {
    spendUsdPerDay, spendUsdPerAgentPerHour, maxConcurrentTasksPerAgent,
    maxDelegationDepth, taskWallclockMinutes,
    autoGreenDisabled: boolean,
    allowedLlmProviders: string[],
    allowedDomains: string[]                  // egress-proxy SNI allowlist mirror
  };
  agents: Record<string, Partial<...>>;
  tools: { allowedTools: string[]; destructiveRequireApproval: string[] };
};
```

### 집행 경로
1. 타입드 툴 API 사전 체크 (`agent-exec`)
2. OS 샌드박스 (userns-remap + seccomp + read-only root + cap_drop + egress-proxy)
3. 사후 감사

### 정책 배포
- `/register` 응답에 정책 전체 스냅샷
- 변경은 hub 서명된 `policy.update` WS 브로드캐스트 → `hubPublicKey`로 검증
- 버전 낮음·서명 실패 시 거부

### Fail-closed 부트스트랩 (NEW v3 #13 명확화)
**레이어 구분**:
- **네트워크 layer (egress-proxy)**: compose 내부 네트워크는 항상 제한 없음. `ziphub-server`로의 호출은 internal-net이라 원래 차단되지 않음. 따라서 "register만 허용"은 네트워크 의미가 아님.
- **Tool API layer (`agent-exec`)**: 정책 로드 전엔 모든 툴 거부. `register` 호출은 `agent-exec`을 통하지 않고 `agent-core`가 직접 수행 → 툴 정책의 영향을 받지 않음 (구조적 카브아웃).

즉 fail-closed는 "에이전트 코드가 정책 받기 전엔 어떤 툴도 못 씀"의 의미. register 호출은 정책 적용 대상 외부에 있음.

### 토큰 회전·즉시 Revocation
- JWT 1h, 15분 회전, 5분 grace
- pause/shutdown 시:
  1. `token_revocations` insert (`expires_at = original_exp + 30s`)
  2. `directory.update` 델타 브로드캐스트 (`revoked` 추가분만)
  3. 해당 에이전트 WS 강제 close
- 피어는 30s 캐시, A2A 호출 시 `kid`로 캐시 조회
- 잔여 윈도우: directory.update 전파 지연 (보통 < 1s, SLO 5s)
- **Race 한정**: 피어 B의 WS도 끊긴 상태면 캐시 갱신 지연. M6 워치독이 B의 stale 감지 시 B의 신규 A2A 수신을 거부 (서버가 directory에서 B 제거)
- 워치독이 `expires_at < now()` 행 자동 삭제 (테이블 무한 성장 방지, NEW v3 #17)

---

## 8. 타입드 툴 API + OS 샌드박스

### (a) 타입드 툴 API (`@ziphub/agent-exec`)
```ts
tools.git.{checkout, commit, merge}     // push 부재
tools.fs.{readFile, writeFile, listDir} // realpath 정규화, /repo 외부 거부
tools.pkg.install(name, version)         // --ignore-scripts 기본, allowlist 시 활성화
tools.test.run(pattern?)
tools.build.run()
tools.llm.complete({...})                // 진행 중 60s 주기 task.progress 자동 발행
                                         // peer 호출 컨텍스트면 peer.call.progress도 발행
```
- Claude Agent SDK 툴 정의는 위 API 1:1 매핑. 비매핑 호출 시 hard reject + audit + spend penalty
- `shell.exec` 부재
- `tools.git.commit`는 자동 `--trailer Ziphub-Task-Id` 추가 (§3.3)

### (b) OS 격리

#### 컨테이너 런타임 (NEW v3 #7, #8, #9 — prereq 없이 부팅)

**기본 (M1~M8 표준)**: 표준 `runc` + `userns-remap`
- 모든 머신에서 `docker compose up` 즉시 작동
- userns-remap은 daemon.json 한 줄 + 사용자 1명 추가 (`scripts/preflight.sh`가 자동화)
- 격리 강도: cap_drop ALL, seccomp default+, no-new-privileges, read-only root

**선택 업그레이드**: `sysbox-runc` (사용자가 호스트에 설치 시)
- `.env`에 `USE_SYSBOX=true` → `compose-override.sysbox.yml` 활성화
- compose-override가 `runtime: sysbox-runc` 추가
- 미설치 환경엔 빈 override → 영향 없음

**daemon.json 가이드** (`scripts/preflight.sh`):
```bash
# /etc/docker/daemon.json 자동 패치 (사용자 동의 후)
{
  "userns-remap": "default",
  "runtimes": {
    "sysbox-runc": { "path": "/usr/bin/sysbox-runc" }   # sysbox 설치 시만
  }
}
# systemctl restart docker
```

#### Gate runner spawn (v5 — host dockerd + socket proxy)

**`docker-proxy` 사이드카** (Tecnativa docker-socket-proxy):
- 베이스: `tecnativa/docker-socket-proxy`
- 호스트 `/var/run/docker.sock`을 `ro`로 마운트
- 환경변수로 화이트리스트 API만 허용:
  ```yaml
  docker-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1                 # /containers/* 허용
      POST: 1                       # POST 메서드 허용
      AUTH: 0
      EXEC: 0                       # /containers/{id}/exec 거부
      INFO: 0
      VOLUMES: 0                    # 볼륨 API 거부 (compose에 선언된 것만 사용)
      NETWORKS: 0
      IMAGES: 0                     # 이미지 빌드/풀 거부 (사전 빌드만)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [control-net]
  ```
- 서버는 `DOCKER_HOST=tcp://docker-proxy:2375`로 접근
- 게이트는 host docker에서 실행 → 명명 볼륨·bind 마운트 모두 정상 동작
- 추가 강화: **`docker-proxy-guard` Bun mini-proxy** (Tecnativa 앞단)가 `containers/create` body 검사:
  - `HostConfig.Privileged === true` reject
  - `HostConfig.Binds`/`Mounts.Source`가 `/`, `/etc`, `/var/run`, `~/.ssh` 등 위험 경로면 reject
  - 허용된 source: `agent-{repo}-node_modules`, `state`, `/home/revil/projects/zipbul/{repo}` 패턴만
  - `HostConfig.CapAdd` 비어있어야 함
  - `HostConfig.SecurityOpt`가 `seccomp=unconfined`·`apparmor=unconfined` 포함 시 reject
  - `HostConfig.PidMode === "host"`/`NetworkMode === "host"` reject
  - M1에 함께 ship (없으면 §20 가드는 종이호랑이)

#### 컨테이너 옵션 (compose, 모든 에이전트·게이트 공통)
```yaml
read_only: true
tmpfs:
  - /tmp:size=512m
  - /run
cap_drop: [ALL]
security_opt:
  - no-new-privileges:true
  - seccomp=./docker/seccomp.json
ulimits:
  nofile: { soft: 1024, hard: 2048 }
  nproc:  { soft: 256,  hard: 512 }
  fsize:  { soft: 1073741824, hard: 1073741824 }
```

#### 볼륨 레이아웃
```yaml
volumes:
  # 레포 rw bind
  - type: bind
    source: /home/revil/projects/zipbul/baker
    target: /repo
  # node_modules는 명명 볼륨 (캐시 + agent와 gate가 공유 가능, gate는 RO 마운트)
  - type: volume
    source: agent-baker-node_modules
    target: /repo/node_modules
  # 빌드 캐시 (선택)
  - type: volume
    source: agent-baker-dist
    target: /repo/dist
  # 공유 상태
  - type: volume
    source: state
    target: /state
```

#### 네트워크 격리 — squid 확정 (NEW v3 #5, #6)

**`egress-proxy` 사이드카 = squid** (tinyproxy는 SNI 검사 불가, 폐기)

`docker/squid.conf`:
```squid
http_port 8888

# SNI peek + allowlist
acl allowed_sni dstdomain "/etc/squid/allowed_domains.txt"
acl CONNECT method CONNECT
ssl_bump peek all
ssl_bump splice allowed_sni
ssl_bump terminate all

http_access allow CONNECT allowed_sni
http_access deny CONNECT
http_access deny all

# CONNECT 외 (HTTP 평문) 도 명시 deny
acl http_method method GET POST PUT DELETE HEAD PATCH
http_access deny http_method
```

`docker/allowed_domains.txt`:
```
api.anthropic.com
.openai.com                  # 와일드카드
generativelanguage.googleapis.com
api.x.ai
registry.npmjs.org
registry.yarnpkg.com
github.com
api.github.com
.githubusercontent.com
codeload.github.com
```

**Per-tool 프록시 설정** (NEW v3 #6 — HTTPS_PROXY 단일 환경변수 가정 폐기):

`agent.Dockerfile` ENTRYPOINT:
```bash
#!/bin/sh
# 1. iptables 룰 (CAP_NET_ADMIN 필요 → 엔트리포인트에서 적용 후 cap drop)
#    실제론 docker는 cap_drop 후 자식 프로세스가 cap 못 얻으므로
#    호스트에서 iptables 적용은 불가. 대안:
#    egress-proxy를 유일한 외부 게이트웨이로 만들어 'NetworkPolicy'를
#    docker network driver로 강제 (compose의 internal: true + sidecar pattern)
#    혹은 init container에서 룰 적용 후 user 전환
#    여기선 'compose network internal: true + egress-proxy만 외부' 패턴 사용

# 2. 도구별 프록시 환경변수
export HTTPS_PROXY=http://egress-proxy:8888
export HTTP_PROXY=http://egress-proxy:8888
export NO_PROXY=ziphub-server,postgres,egress-proxy,docker-proxy
export BUN_CONFIG_HTTPS_PROXY=http://egress-proxy:8888
export npm_config_https_proxy=http://egress-proxy:8888
export npm_config_http_proxy=http://egress-proxy:8888

# 3. git 프록시 (전역 config)
git config --global http.proxy http://egress-proxy:8888
git config --global https.proxy http://egress-proxy:8888

exec bun run /app/agent.ts
```

**네트워크 정책 (compose, v5)**:
```yaml
networks:
  control-net:
    driver: bridge
    internal: true            # 외부 NAT 없음. 에이전트·서버·docker-proxy 통신 전용
  egress-net:
    driver: bridge
    internal: false           # 외부 인터넷 가능. 서버·egress-proxy만
```

소속:
- `agent-{repo}` → `control-net`만
- `ziphub-server` → `control-net` + `egress-net` (양쪽 다리)
- `egress-proxy` → `control-net` + `egress-net` (에이전트·서버 외부 호출 통로)
- `docker-proxy` → `control-net`만
- `postgres` → `control-net`만

에이전트의 외부 호출 경로: control-net 안의 egress-proxy → egress-net → 외부 (squid SNI allowlist 통과). 다른 외부 경로 없음.
에이전트 ↔ 서버 통신 경로: control-net 직접 (proxy 미경유). `ZIPHUB_URL=http://ziphub-server:3000` 도달 가능.
에이전트 ↔ 에이전트 (A2A): control-net 직접.

---

## 9. 코디네이션·락

### 브랜치
- 모든 작업은 `ziphub/task-{taskId}` 브랜치
- main 직접 쓰기 차단 (구조적)
- 자동 머지 = 로컬 squash + trailer commit (§3.3)

### 락 획득
```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended(key, 0));
INSERT INTO locks(...) ON CONFLICT (key) DO UPDATE SET ... WHERE locks.expires_at < now();
COMMIT;
```

### TTL = task.progress 기반 (agent liveness 무관)
- `task.progress` 수신 시 `last_progress_at = now()`, `expires_at = now() + 15min`

### 통합 대기-그래프
- 노드: agent, task / 엣지: parent, lock 대기, lock holder, A2A 응답 대기
- 5초 주기 순환 탐지 (Postgres 재귀 CTE, 12 에이전트 규모 < 1ms)
- 하드 백스톱:
  - 락 보유 최대 15분 (progress로 연장 가능)
  - **A2A 응답 최대 15분** (NEW v3 #12: caller AND callee 양쪽 keepalive로 연장 가능)

### `peer.call.progress` 발행 주기 (NEW v3 #12)
- **Caller 측**: A2A 호출이 60s 넘게 응답 없으면 60s 주기로 발행 (서버에 "아직 기다리는 중" 보고)
- **Callee 측**: 받은 A2A 호출 처리 중에 `agent-a2a` 미들웨어가 자동으로 60s 주기 발행. 추가로 `tools.llm.complete`이 자기 task.progress 발행 시, 부모 peer 호출 컨텍스트가 있으면 peer.call.progress도 동시 발행
- 양쪽 keepalive가 워치독 timeout 타이머 리셋
- 둘 다 끊기면 timeout 정상 발동

---

## 10. 복구·워치독

### 서버 재시작 복구
1. DB 헬스·마이그레이션
2. `working`/`gated`/`input-required` Task 스냅샷
3. 40s 재연결 대기 창
4. 에이전트 재연결 시 `hello { lastAckSeq, inFlightTasks[] }` → 재전송 범위 결정
5. 미접속 에이전트 Task:
   - `working`/`gated` → **git log trailer 검증 먼저** (§3.3 리콘실리에이션)
     - 매치 → `merged` 확정
     - 매치 없음 → `failed(reason='server-recovery-orphaned')` + 락 해제
   - `input-required` → 보존
6. `peer_calls` timeout 마감
7. 만료 락·revocation 정리

### 에이전트 재부팅 시 git 점검 (NEW v3 #3 — squash 정합)
```bash
# squash mode 정합 점검 (MERGE_HEAD는 --squash에서 생성 안 됨)
[[ -f .git/index.lock ]]                    && DIRTY=true
[[ -n "$(git status --porcelain)" ]]         && DIRTY=true
[[ -n "$(git ls-files -u)" ]]                && DIRTY=true   # unmerged
[[ -n "$(git diff --cached --name-only)" ]]  && DIRTY=true   # staged 변경 잔존
git log main --grep="Ziphub-Task-Id:" --fixed-strings -n 5   # 최근 자동머지 로그

if [[ $DIRTY ]]; then
  emit 'repo.dirty { reasons: [...] }'
  start in 'paused' state
fi
```

### 에이전트 장기 오프라인 (>1h)
1. JWT grace 만료 → `/register` 재호출 (동일 `agentId`)
2. 서버는 `agents` 행 갱신, `token_kid` 회전, 기존 inFlight Task DB 상태 확인
3. 에이전트 `hello` 로 inFlightTasks 보고
4. 서버가 timeout 처리한 Task는 `terminated_by_server=true` → 에이전트 cancel
5. 살아있는 Task만 재개

### 에이전트 상태
- `active`(75s), `stale`(75-180s), `unreachable`(180s+, task.progress 10분 이상 경과 시만 failed)

### 워치독 (10s)
- stale/unreachable 처리
- stuck task (10분 progress 없음) → cancel
- 만료 락·revocation 정리
- `peer_calls` timeout 마감
- orphan 브랜치는 에이전트 `branch.confirm-dead` 후 삭제
- spend 한도 초과 → `control.shutdown(agent)`

### 글로벌 서킷 브레이커
- 게이트 실패율 30%/h → 전역 정지
- revert율 10%/주 → auto-green off

---

## 11. Outcome 피드백 + 신뢰 점수

### 시그널
- 즉시: 게이트 통과·재시도·소요시간
- 단기 (24h): bun test 재실행
- 중기 (7d): revert 탐지, 동일 경로 재churn

### Additive Trust Score (NEW v3 #10 — EMA 호명 폐기)
**공식**:
```
score_new = clamp(score_old + δ, 0, 1)

δ:
  +0.02   merged + 24h CI 통과
  -0.10   revert 감지
  -0.05   동일 경로 재churn (7d 내)
  -0.02   게이트 3회 재시도 후 실패
```
- 초기 0.5
- 명칭 명시: 이는 **EMA가 아닌 saturating additive counter**. 5000 successes 후 한 번의 revert가 0.90으로만 떨어지는 dynamics 의도.
- 진짜 EMA 원하면 `score = α·outcome + (1-α)·score` (α=0.1 등). M8 운영 데이터 보고 결정 가능. 일단 additive로 시작.

### Cold-start 게이트 (NEW v3 #11)
- "성공" = 사람 승인 + 머지 + 24h 내 revert 미감지
- 5회 연속 성공 → `cold_start=false`
- 1회 revert → 카운터 리셋

### 머지 자격 게이팅
- `score ≥ 0.7 && !cold_start` → auto-green 자격
- `score ≤ 0.3` → pr-green 강제
- `score ≤ 0.1` → 자동 paused

### Revert 루프 차단
- `outcomes.same_path_churn ≥ 2` → (agent, path) 블록리스트, 해당 경로 수정 자동 review-required

### 점수 비가시화
- 에이전트 자기 점수 조회 API 없음 (편향·게이밍 노이즈 차단, 보안 보장은 아님)

---

## 12. 사람 개입 경로

### 트리거
- 결정적 게이트 3회 재시도 소진
- 정책 위반 감지
- 데드락 자동 abort 후 재발
- `same_path_churn ≥ 2`
- Task spec `requireApproval: true`
- `repo.dirty`

### Trigger별 기본 액션 (단일 디폴트 안 씀)
- 게이트 실패 반복 → 48h 후 `paused`
- 정책 위반 → 즉시 `paused`
- 데드락 → 12h 후 가장 낮은 신뢰 에이전트 task abort
- 체크포인트 → 48h 후 `canceled` (브랜치 보존)
- repo.dirty → 사람 응답까지 무기한 보류

### UI 큐
- 원클릭 approve/reject/comment
- 48h 미응답 → 해당 에이전트 자동 paused + 빨간 배너

---

## 13. 관찰·UI

### 화면
오버뷰 / 타임라인 / Task 상세 / 토폴로지 / 개입 큐 / 정책 에디터(M8) / 감사 뷰어(M8)

### 로그 뷰어 (NEW v3 #14, #15)
- 활성 task: 에이전트가 `task.log.tick { lastByteOffset }` WS → 서버는 **task별 long-lived FD**(처음 tick 시 open, 종결 시 close) 사용 → SSE fanout
- 종결 task: 파일 전체 read on demand
- 쓰기: agent-core가 `O_APPEND`, line-buffered NDJSON (`\n` 미수신 시 다음 tick까지 대기)
- inotify 미사용
- 보존: 종결 task 30일 후 삭제 (cron)
- /state는 로컬 ext4/overlayfs 가정 (네트워크 FS 사용 시 fsync 필요, 현재 범위 밖)

### 기술
React 19 + Zustand + Tanstack Query + react-router + reactflow.
인증: `UI_TOKEN` env, 최초 접속 시 입력. `127.0.0.1:3000` 바인드.

---

## 14. 배포 (compose가 prereq 없이 부팅)

### `scripts/preflight.sh`
```bash
#!/bin/bash
# 1. daemon.json 점검·패치 (사용자 동의)
# 2. userns-remap 설정 (없으면 추가)
# 3. (선택) sysbox-runc 감지·등록
# 4. /home/revil/projects/zipbul 권한 점검
```

### `docker-compose.yml` (v5 요지)
```yaml
services:
  postgres:
    image: postgres:17
    environment: { POSTGRES_DB: ziphub, POSTGRES_USER: ziphub, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD} }
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [control-net]
    healthcheck: ...

  egress-proxy:
    build: { context: ., dockerfile: docker/egress-proxy.Dockerfile }
    networks: [control-net, egress-net]
    volumes:
      - ./docker/squid.conf:/etc/squid/squid.conf:ro
      - ./docker/allowed_domains.txt:/etc/squid/allowed_domains.txt:ro
    restart: unless-stopped

  docker-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1
      POST: 1
      AUTH: 0
      EXEC: 0
      INFO: 0
      VOLUMES: 0
      NETWORKS: 0
      IMAGES: 0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [control-net]
    restart: unless-stopped

  ziphub-server:
    build: { context: ., dockerfile: docker/server.Dockerfile }
    depends_on:
      postgres: { condition: service_healthy }
      egress-proxy: { condition: service_started }
      docker-proxy: { condition: service_started }
    environment:
      DATABASE_URL: postgres://ziphub:${POSTGRES_PASSWORD}@postgres:5432/ziphub
      DOCKER_HOST: tcp://docker-proxy:2375
      UI_TOKEN: ${UI_TOKEN}
      HTTPS_PROXY: http://egress-proxy:8888
      HTTP_PROXY: http://egress-proxy:8888
      NO_PROXY: postgres,egress-proxy,docker-proxy,ziphub-server
    ports: ["127.0.0.1:3000:3000"]
    volumes: [state:/state]
    networks: [control-net, egress-net]   # 다리 역할
    restart: unless-stopped

  # (compose-agents.yml에서 자동 생성)
  agent-baker:
    build: { context: ., dockerfile: docker/agent.Dockerfile }
    environment:
      AGENT_ID: agent:baker
      REPO_NAME: baker
      ZIPHUB_URL: http://ziphub-server:3000
    volumes:
      - type: bind
        source: /home/revil/projects/zipbul/baker
        target: /repo
      - type: volume
        source: agent-baker-node_modules
        target: /repo/node_modules
      - type: volume
        source: state
        target: /state
    read_only: true
    tmpfs: [/tmp:size=512m, /run]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true, seccomp=./docker/seccomp.json]
    ulimits: { nofile: 2048, nproc: 512 }
    networks: [control-net]               # 외부 직접 접근 불가
    restart: unless-stopped

volumes:
  pgdata:
  state:
  agent-baker-node_modules:
  # ...

networks:
  control-net:
    driver: bridge
    internal: true
  egress-net:
    driver: bridge
```

### Sysbox 선택 업그레이드 (`docker-compose.sysbox.yml`)
```yaml
# .env에 USE_SYSBOX=true 설정 시 적용:
# docker compose -f docker-compose.yml -f docker-compose.sysbox.yml up
services:
  agent-baker:
    runtime: sysbox-runc
  # ... 모든 에이전트
```

---

## 15. 인증·토큰

- 서버 Ed25519 키쌍 (`/state/keys/hub.{pub,priv}`, mode 600)
- 토큰 발급은 hub 단독 권한
- JWT payload: `{ sub: agentId, kid, iat, exp(1h), scope }`
- 15분 회전, 5분 grace
- A2A 피어 호출은 hub 공개키로 직접 검증 + revocation 캐시
- 즉시 revocation: insert + directory.update 델타 + WS 강제 close
- 워치독이 만료 revocation 자동 삭제 (NEW v3 #17)

---

## 16. `@ziphub/agent-*` 패키지

- `agent-core`: 등록·토큰·WS·재연결·저널·seq·idempotency·정책 캐시·정책 서명 검증·heartbeat·directory 캐시
- `agent-exec`: 타입드 툴 API. `tools.llm.complete`은 60s 주기 task.progress 자동 발행. peer 호출 컨텍스트면 peer.call.progress도 발행
- `agent-a2a`: `@a2a-js/sdk` 래퍼, 송수신 미들웨어로 peer.call.* 자동 발행 (callee도 60s 주기 keepalive), JWT 자체 검증, ziphub↔A2A 브릿지
- `agent-runtime`: 묶음 + `createAgent` 엔트리

---

## 17. 마일스톤

### M1 — 인프라
- compose 5 서비스: postgres, egress-proxy(squid), docker-proxy(Tecnativa), **docker-proxy-guard(Bun mini-proxy)**, ziphub-server
- 서버는 `DOCKER_HOST=tcp://docker-proxy-guard:2375` (guard → tecnativa → host docker.sock)
- `scripts/preflight.sh` (daemon.json·userns-remap 패치)
- `packages/shared` 스키마, 마이그레이션, 파티션
- **수락**: prereq 없이 `bash scripts/preflight.sh && docker compose up -d` → 모든 서비스 healthy, 마이그레이션 성공, 서버가 docker-proxy-guard를 통해 정상 컨테이너 spawn 가능, 위험 옵션(`Privileged=true`, `Binds: ["/:/..."]` 등) 시도 시 guard가 reject

### M2 — 정책·토큰·감사 + WS 왕복
- 정책 스키마·서명·발행·검증
- JWT 발급·회전·revocation·30s 캐시
- `agent-core` 최소본
- audit·spend 기록
- **수락**: stub `onTask` 반환하는 mock 에이전트가 register → 정책 수신 → WS 유지 → 정책 변경 즉시 반영 → revocation 시 즉시 WS close + peer 측 30s 내 거부

### M3 — 타입드 툴 + OS 샌드박스
- `agent-exec` 전 툴 구현
- `agent.Dockerfile` (userns-remap 기반, ENTRYPOINT가 per-tool 프록시 환경변수 + git config 설정)
- 샌드박스 negative 테스트 (NEW v3 #19, 50개 이상, **카테고리 6**):
  1. **path traversal** (8): `/etc/passwd`·`../../etc/`·심볼릭 링크·realpath 우회
  2. **network direct** (10): `curl 8.8.8.8`·SNI 우회·proxy 우회·DNS over plain
  3. **postinstall script** (8): 악성 npm 패키지 install 시도·`--ignore-scripts` 우회 시도
  4. **syscall via cap** (6): `mount`·`mknod`·`ptrace` 등 cap 의존 시스템콜
  5. **resource exhaustion** (8): fork bomb·메모리·디스크·파일 디스크립터
  6. **capability bypass** (10): setuid·setgid·`/proc/self/status` 변조·user namespace 탈출
- **수락**: 50+ 케이스 전부 reject

### M4 — 상태기계·저널·A2A 브릿지
- `agent-a2a`, `agent-runtime`
- task_events 파티션·이벤트 커서 race 검증
- 두 mock 에이전트 간 A2A end-to-end (peer.call.* + keepalive 포함)
- **수락**: WS flap·서버 재시작·에이전트 재시작에도 Task 중복 처리 없이 완료

### M5 — 게이트 + 위험도 + 자동 머지
- 서버가 docker-proxy를 통해 host dockerd에 ephemeral gate 컨테이너 spawn
- agent 명명 볼륨을 `ro` 마운트 + lockfile 변경 시 ephemeral 볼륨에 install
- 위험도 매처
- 머지 절차 (§3.3 강화), trailer 검증, commit-msg 훅 점검
- **시드 절차** (NEW v3 #11): `scripts/seed-agent-trust.ts --agent agent:baker --cold-start=false` (M5 acceptance·테스트 한정)
- **수락 (2개 row)**:
  - 시드된 에이전트가 docs-only 변경을 auto-green으로 로컬 머지 (trailer 검증 통과)
  - 미시드 신규 에이전트의 docs-only 변경은 pr-green 브랜치로만 남음 (auto-green 거부)

### M6 — 워치독·복구·서킷
- 서버 재시작 복구 + git log 리콘실리에이션
- 에이전트 mid-merge 점검 (squash 정합)
- 락 expiry·stuck task·peer_calls timeout
- 글로벌 서킷
- token_revocations 자동 cleanup
- **수락**: chaos test (서버 kill -9, 에이전트 kill, postgres restart) 정합성 유지

### M7 — UI
- 오버뷰·타임라인·Task 상세·토폴로지·개입 큐·로그 뷰어 (long-lived FD)

### M8 — Outcome + 신뢰 + 12 레포 롤아웃
- revert 탐지·additive trust score·블록리스트
- `compose-agents.yml` 생성 스크립트
- 12 레포에 `agent.ts` + `ziphub.config.ts` 커밋·롤아웃
- 정책 에디터·감사 뷰어 UI

---

## 18. 운영

```bash
cp .env.example .env       # POSTGRES_PASSWORD, UI_TOKEN
bash scripts/preflight.sh  # daemon.json·userns-remap (1회)
docker compose up -d
# UI: http://127.0.0.1:3000
# 에이전트 롤아웃 (M8):
./scripts/rollout-agents.ts --repos baker,gildash,...
```

---

## 19. 수용하지 않는 대안

- NATS — 12 에이전트엔 과잉
- 프록시 허브 — SPOF
- 단일 풀스택 패키지 — 생명주기 다름
- 정규식 shell 필터 — 보안 theater
- host 직접 실행 — 격리 불가
- 자동 git push — 폭발 반경 큼
- tinyproxy egress — SNI 검사 불가
- 호스트 docker.sock 직접 마운트 — root 동등권. docker-proxy로 화이트리스트 격리
- sysbox-runc 강제 — prereq 부담, 선택 업그레이드로 격하
- rootless dind 게이트 컨테이너 (gate-controller) — cross-daemon 볼륨·namespace 분리 문제 폐기

---

## 20. 위협 모델

### 자산
- 12 레포 소스·`.env`·lockfile
- LLM API 키
- hub 서명 개인키
- 사용자 git 자격증명 (에이전트 노출 안 함)

### 행위자
- 순진한 실수 (주)
- 프롬프트 인젝션 (코드·README·커밋)
- 공급망
- 외부 직접 접근 — 범위 밖 (localhost-only)

### 보호 경계
1. 에이전트 간 — 컨테이너 + 자기 레포만, control-net `internal: true` (외부 NAT 없음)
2. 에이전트 → 서버 — JWT 서명·검증, 즉시 revocation, WS 강제 close
3. 에이전트 → 외부 — squid SNI allowlist, 다른 경로 없음
4. 에이전트 → git remote — `tools.git.*`에 push 부재 + squid가 git remote URL CONNECT 차단
5. 사용자 git 자격증명 — 마운트 안 함
6. UI → 서버 — 127.0.0.1 + UI_TOKEN

### 게이트 러너 격리 (v5 결정)
- **선택**: host dockerd + `docker-proxy` (Tecnativa docker-socket-proxy) 사이드카로 화이트리스트된 docker API만 노출
- 서버 컨테이너에 host docker.sock 직접 마운트 안 함 (proxy가 격리 경계)
- 게이트 컨테이너 자체는 cap_drop ALL · read-only root · seccomp · userns-remap (host root 동등권 없음)
- proxy의 추가 가드: `HostConfig.Privileged=true`, `Binds: ["/:/..."]`, `SecurityOpt`/`CapAdd` 위험 옵션 reject (POST body 검사)
- 잔여 위험:
  - **proxy 자체의 CVE 또는 화이트리스트 우회**: Tecnativa proxy 정기 업데이트, body 검사를 mini Bun proxy로 보강 가능
  - **서버 코드 자체가 침해되면** docker-proxy 권한으로 임의 컨테이너 spawn 가능 — 서버는 trusted code, 자체 침해는 별도 위협 (감사 로그 + UI 알림)
- 강화 옵션: 사용자가 `USE_SYSBOX=true` 시 게이트·에이전트 모두 sysbox-runc 적용 (호스트에 sysbox 사전 설치 필요)
- microVM(firecracker)은 후속 검토

### 감지·대응
- 프롬프트 인젝션: 비매핑 툴 호출 시 hard reject + spend penalty + audit
- 공급망: 의존성 변경 항상 pr-green 이상, lockfile diff audit, `--ignore-scripts` 기본
- 토큰 유출: 1h + 15분 회전 + 즉시 revocation + 30s 캐시
- 감사: 모든 툴·WS·정책·사람 액션 기록

### 수용 위험
- 에이전트가 자기 레포 내 민감 파일을 LLM에 송신: LLM 프로바이더 TOS + egress allowlist에 의존
- JWT revocation 잔여 (~1초): 즉시 close + 캐시로 최소화

---

## 21. 열린 결정

### 확정 (v4)
- Git 원격 push 자동 금지
- 1 에이전트 1 레포 1 컨테이너
- 정책 엔진 M2 선행
- task.log 파일 + tick + long-lived FD
- auto-green에서 의존성·lockfile·테스트 제외
- 사람 개입 trigger별 TTL 48h → paused
- 머지: 낙관적 + git trailer + `--fixed-strings`/`interpret-trailers` 리콘실리에이션
- squash mode 정합 점검 (`MERGE_HEAD` 점검 폐기)
- 컨테이너 런타임: **표준 runc + userns-remap 기본**, sysbox-runc는 선택 업그레이드
- 게이트 spawn: host dockerd + docker-proxy (Tecnativa) 사이드카로 화이트리스트된 API만 노출. 서버에 host docker.sock 직접 마운트 안 함
- 네트워크: control-net(internal, 에이전트·서버·proxy) + egress-net(서버·egress-proxy만). 에이전트는 control-net만 → 외부 직접 차단
- egress: **squid + SNI peek + allowlist**, tinyproxy 폐기
- per-tool 프록시 설정: bun/npm/git 각각 명시
- 신뢰 점수: **additive saturating counter** (EMA 호명 폐기)
- cold_start 성공 정의: 사람 승인 + 머지 + 24h 무 revert
- `peer.call.progress`: caller·callee 양쪽 60s 발행
- token_revocations TTL 자동 cleanup, directory.update는 델타

### 사용자 결정 필요
1. **모델 선택**: 전 에이전트 sonnet, review 에이전트 opus 권장. 비용과 함께 확정
2. **Spend 한도 (USD)**: 예시 $20/day/agent, $100/day/total. 사용자 지정
3. **원격 push UI 버튼**: M8까지 터미널 직접 권장. 이후 옵션
4. **sysbox-runc 호스트 설치 의향**: 기본은 미설치 가정. 설치 시 `USE_SYSBOX=true` 한 줄로 활성화

---

## 22. 한 페이지 요약

- **스택**: Bun + TS + React + Postgres 17 + Docker Compose (localhost)
- **컴포즈 5 서비스**: postgres / egress-proxy(squid) / docker-proxy(Tecnativa) / docker-proxy-guard(Bun mini-proxy) / ziphub-server. 에이전트는 동적 추가
- **격리**: userns-remap + cap_drop ALL + read-only root + seccomp + control-net internal + squid SNI allowlist + docker-proxy 화이트리스트. sysbox-runc는 선택
- **보안 주 경로**: 타입드 툴 API + OS 샌드박스 + SNI proxy
- **백본**: Postgres만, log는 파일 + tick fanout + long-lived FD
- **프로토콜**: HTTP 등록 + WS 지속 + 직접 A2A (JWT 자체검증 + 30s revocation 캐시)
- **Task 상태**: 전 전이 낙관적, ack-wait 없음, git trailer 리콘실리에이션 (`--fixed-strings`+`interpret-trailers`)
- **머지**: squash + `--trailer` + 충돌·trailer-strip 검증, 로컬만, push는 사람
- **게이트**: build/type/lint/test/coverage, ephemeral 컨테이너, agent volume RO 스냅샷
- **위험도**: auto-green(docs/examples만, 콜드스타트+신뢰 통과) / pr-green / never-auto
- **정책**: fail-closed 부트스트랩(tool API layer 카브아웃), JWT 서명, 즉시 revocation
- **복구**: 서버 재시작 + 에이전트 squash 정합 점검 + 장기 오프라인, 통합 대기그래프, 하드 백스톱
- **신뢰**: additive saturating counter, cold_start = 5회 사람 승인 + 24h 무 revert
- **개입**: trigger별 48h → paused
- **SLO**: revert > 10% 전역 auto-green off, spend 한도, localhost-only
