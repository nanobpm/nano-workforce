## [0.118.2](https://github.com/nanobpm/nano-workforce/compare/v0.118.1...v0.118.2) (2026-08-21)


### Bug Fixes

* **deps:** update dependency @nanobpm/urban to ^0.75.0 ([#427](https://github.com/nanobpm/nano-workforce/issues/427)) ([ac52457](https://github.com/nanobpm/nano-workforce/commit/ac52457c9c07ab951ae1ed415cb62fed60df9e4e))

## [0.118.1](https://github.com/nanobpm/nano-workforce/compare/v0.118.0...v0.118.1) (2026-08-21)


### Bug Fixes

* **ci:** gate releases on green CI and drop perma-red gen:check ([#424](https://github.com/nanobpm/nano-workforce/issues/424)) ([a57746b](https://github.com/nanobpm/nano-workforce/commit/a57746bafa264bf480eb8053cc2e133aa450f8b7))
* **release:** use jq -s to slurp check-runs; gh --slurp rejects --jq ([#425](https://github.com/nanobpm/nano-workforce/issues/425)) ([d5c3fce](https://github.com/nanobpm/nano-workforce/commit/d5c3fce2652f0b275a5d71d6c8e45e47c403a289))

# [0.118.0](https://github.com/nanobpm/nano-workforce/compare/v0.117.0...v0.118.0) (2026-08-21)


### Features

* **delivery-graphs:** human-facing Delivery Graphs UI surface ([#386](https://github.com/nanobpm/nano-workforce/issues/386)) ([#418](https://github.com/nanobpm/nano-workforce/issues/418)) ([3e5877d](https://github.com/nanobpm/nano-workforce/commit/3e5877d2e9f7dc4c7d7934b556e4eefd93685f0f)), closes [#405](https://github.com/nanobpm/nano-workforce/issues/405) [#397](https://github.com/nanobpm/nano-workforce/issues/397) [#374](https://github.com/nanobpm/nano-workforce/issues/374)

# [0.117.0](https://github.com/nanobpm/nano-workforce/compare/v0.116.0...v0.117.0) (2026-08-21)


### Features

* **delivery-graph:** gated startDeliveryGraph dispatch door (ADR 0005 S5) ([#405](https://github.com/nanobpm/nano-workforce/issues/405)) ([dc7c78e](https://github.com/nanobpm/nano-workforce/commit/dc7c78e03ef1a3a8cfb70e4e51b721a4419c8962)), closes [#380](https://github.com/nanobpm/nano-workforce/issues/380)

# [0.116.0](https://github.com/nanobpm/nano-workforce/compare/v0.115.0...v0.116.0) (2026-08-20)


### Features

* replace deterministic scope regex with a scope-integrity agent classifier ([#403](https://github.com/nanobpm/nano-workforce/issues/403)) ([588b869](https://github.com/nanobpm/nano-workforce/commit/588b8699ea738ff0772f23d68bc051e8ff417d49)), closes [#395](https://github.com/nanobpm/nano-workforce/issues/395) [#395](https://github.com/nanobpm/nano-workforce/issues/395) [#395](https://github.com/nanobpm/nano-workforce/issues/395) [398/#399](https://github.com/nanobpm/nano-workforce/issues/399) [#395](https://github.com/nanobpm/nano-workforce/issues/395) [#395](https://github.com/nanobpm/nano-workforce/issues/395) [#395](https://github.com/nanobpm/nano-workforce/issues/395)

# [0.115.0](https://github.com/nanobpm/nano-workforce/compare/v0.114.1...v0.115.0) (2026-08-20)


### Features

* **engine:** startup preflight + canonical engine address resolution ([#391](https://github.com/nanobpm/nano-workforce/issues/391)) ([#404](https://github.com/nanobpm/nano-workforce/issues/404)) ([16fcb71](https://github.com/nanobpm/nano-workforce/commit/16fcb711f190341f03fd84914fa66c1ee704b78c)), closes [Magikcraft/nano-bpm#940](https://github.com/Magikcraft/nano-bpm/issues/940)

## [0.114.1](https://github.com/nanobpm/nano-workforce/compare/v0.114.0...v0.114.1) (2026-08-20)


### Bug Fixes

* **convergence-loop:** give the scope-integrity gate a human-override door ([#395](https://github.com/nanobpm/nano-workforce/issues/395)) ([#401](https://github.com/nanobpm/nano-workforce/issues/401)) ([23f8354](https://github.com/nanobpm/nano-workforce/commit/23f83541c57b3474b36a92baa1d88bdd6535df9b))

# [0.114.0](https://github.com/nanobpm/nano-workforce/compare/v0.113.0...v0.114.0) (2026-08-20)


### Features

* **delivery-graphs:** integration runner deploys a compiled delivery graph as an engine-native process ([#397](https://github.com/nanobpm/nano-workforce/issues/397)) ([4ae2394](https://github.com/nanobpm/nano-workforce/commit/4ae239412194bfd346cde3213b15d17fad487bbc)), closes [#379](https://github.com/nanobpm/nano-workforce/issues/379)

# [0.113.0](https://github.com/nanobpm/nano-workforce/compare/v0.112.0...v0.113.0) (2026-08-20)


### Features

* **delivery-graph:** `human` node as a scheduled user task that emits a typed fact (ADR 0005 S3) ([#389](https://github.com/nanobpm/nano-workforce/issues/389)) ([2266f9c](https://github.com/nanobpm/nano-workforce/commit/2266f9c36f194a7b1bfa995925968353131040e4)), closes [#378](https://github.com/nanobpm/nano-workforce/issues/378)

# [0.112.0](https://github.com/nanobpm/nano-workforce/compare/v0.111.1...v0.112.0) (2026-08-20)


### Features

* **plan-fanout:** implement-stage escalation net + Tasks-inbox projection ([#358](https://github.com/nanobpm/nano-workforce/issues/358), [#360](https://github.com/nanobpm/nano-workforce/issues/360)) ([#387](https://github.com/nanobpm/nano-workforce/issues/387)) ([c884074](https://github.com/nanobpm/nano-workforce/commit/c884074ca9266d5a17c44d3a1286bb667b43a73a))

## [0.111.1](https://github.com/nanobpm/nano-workforce/compare/v0.111.0...v0.111.1) (2026-08-20)


### Bug Fixes

* **merge:** gate red declared-required checks in classifyMergeability ([#393](https://github.com/nanobpm/nano-workforce/issues/393)) ([f40412a](https://github.com/nanobpm/nano-workforce/commit/f40412a07a51f3274a30274f266a099e3036741a)), closes [#392](https://github.com/nanobpm/nano-workforce/issues/392) [#348](https://github.com/nanobpm/nano-workforce/issues/348)

# [0.111.0](https://github.com/nanobpm/nano-workforce/compare/v0.110.0...v0.111.0) (2026-08-20)


### Features

* **readiness:** add pr/merge-state ReadinessProbe kind (ADR 0005 S2) ([#385](https://github.com/nanobpm/nano-workforce/issues/385)) ([860e031](https://github.com/nanobpm/nano-workforce/commit/860e03134b428c73426621acb14ccd9a3ab94149)), closes [#258](https://github.com/nanobpm/nano-workforce/issues/258) [owner/repo#N](https://github.com/owner/repo/issues/N) [#377](https://github.com/nanobpm/nano-workforce/issues/377) [owner/repo#N](https://github.com/owner/repo/issues/N)

# [0.110.0](https://github.com/nanobpm/nano-workforce/compare/v0.109.0...v0.110.0) (2026-08-20)


### Features

* DeliveryGraph JSON contract + pure validator (ADR 0005 S0) ([#384](https://github.com/nanobpm/nano-workforce/issues/384)) ([ae85e1a](https://github.com/nanobpm/nano-workforce/commit/ae85e1af220844f961f6161d4f676aa289d86693)), closes [#375](https://github.com/nanobpm/nano-workforce/issues/375) [#227](https://github.com/nanobpm/nano-workforce/issues/227)

# [0.109.0](https://github.com/nanobpm/nano-workforce/compare/v0.108.0...v0.109.0) (2026-08-20)


### Features

* **skill:** add nano-workforce operator bootstrap skill ([#382](https://github.com/nanobpm/nano-workforce/issues/382)) ([ef6701f](https://github.com/nanobpm/nano-workforce/commit/ef6701f4df76bcfc762ddec20d745bf5edd0ec1b))

# [0.108.0](https://github.com/nanobpm/nano-workforce/compare/v0.107.2...v0.108.0) (2026-08-20)


### Features

* **derivation-parity:** un-park retro to full whole-model parity ([#372](https://github.com/nanobpm/nano-workforce/issues/372)) ([1320838](https://github.com/nanobpm/nano-workforce/commit/1320838251646258ec2151a547ed2b5573ce1168)), closes [nano-ide#405](https://github.com/nano-ide/issues/405) [355/#356](https://github.com/nanobpm/nano-workforce/issues/356) [#371](https://github.com/nanobpm/nano-workforce/issues/371)

## [0.107.2](https://github.com/nanobpm/nano-workforce/compare/v0.107.1...v0.107.2) (2026-08-20)


### Bug Fixes

* **ci:** close the merge-skew failure class — re-check whole-repo invariants on the post-merge state ([#367](https://github.com/nanobpm/nano-workforce/issues/367)) ([62f5214](https://github.com/nanobpm/nano-workforce/commit/62f5214961cdb82a708d7cc08acecbf5eecf25ed)), closes [#359](https://github.com/nanobpm/nano-workforce/issues/359) [#365](https://github.com/nanobpm/nano-workforce/issues/365) [#366](https://github.com/nanobpm/nano-workforce/issues/366)

## [0.107.1](https://github.com/nanobpm/nano-workforce/compare/v0.107.0...v0.107.1) (2026-08-20)


### Bug Fixes

* **merge-loop:** converge PRs merged/closed out-of-band at every merge-stage wait ([#370](https://github.com/nanobpm/nano-workforce/issues/370)) ([c673c82](https://github.com/nanobpm/nano-workforce/commit/c673c823b6ed5dde5710c4cb677f7c6f01ae59de)), closes [nanobpm/nano-workforce#368](https://github.com/nanobpm/nano-workforce/issues/368)

# [0.107.0](https://github.com/nanobpm/nano-workforce/compare/v0.106.3...v0.107.0) (2026-08-20)


### Features

* port nwf models to defineFlow (S5, [#320](https://github.com/nanobpm/nano-workforce/issues/320)) ([#353](https://github.com/nanobpm/nano-workforce/issues/353)) ([c0b2d9d](https://github.com/nanobpm/nano-workforce/commit/c0b2d9ddea4f5c56159f011ca70203aa3f3c91fe)), closes [nanobpm/nano-ide#314](https://github.com/nanobpm/nano-ide/issues/314) [355/#356](https://github.com/nanobpm/nano-workforce/issues/356) [nano-ide#405](https://github.com/nano-ide/issues/405)

## [0.106.3](https://github.com/nanobpm/nano-workforce/compare/v0.106.2...v0.106.3) (2026-08-20)


### Bug Fixes

* **models:** regenerate stale retro.bpmn DI ([#365](https://github.com/nanobpm/nano-workforce/issues/365)) ([5619ee5](https://github.com/nanobpm/nano-workforce/commit/5619ee5805fb788ae5deebeb75bb0aa11f9c478d)), closes [355/#356](https://github.com/nanobpm/nano-workforce/issues/356)

## [0.106.2](https://github.com/nanobpm/nano-workforce/compare/v0.106.1...v0.106.2) (2026-08-20)


### Bug Fixes

* **velocity:** bucket burn-up by local timezone, not UTC ([#361](https://github.com/nanobpm/nano-workforce/issues/361)) ([#362](https://github.com/nanobpm/nano-workforce/issues/362)) ([84d842a](https://github.com/nanobpm/nano-workforce/commit/84d842ad443fba8a0c399bdd5f4fca466da4a21c))

## [0.106.1](https://github.com/nanobpm/nano-workforce/compare/v0.106.0...v0.106.1) (2026-08-20)


### Bug Fixes

* **migrations:** gate migration immutability + add upgrade smoke test ([#357](https://github.com/nanobpm/nano-workforce/issues/357)) ([#359](https://github.com/nanobpm/nano-workforce/issues/359)) ([7f7c6a6](https://github.com/nanobpm/nano-workforce/commit/7f7c6a6c59dac33602441c729dca897b3b23fabc)), closes [#311](https://github.com/nanobpm/nano-workforce/issues/311) [#316](https://github.com/nanobpm/nano-workforce/issues/316) [#351](https://github.com/nanobpm/nano-workforce/issues/351) [#355](https://github.com/nanobpm/nano-workforce/issues/355)

# [0.106.0](https://github.com/nanobpm/nano-workforce/compare/v0.105.0...v0.106.0) (2026-08-20)


### Features

* escalate unmet/undisclosed conformance deviations to the Tasks inbox ([#356](https://github.com/nanobpm/nano-workforce/issues/356)) ([5ad24bc](https://github.com/nanobpm/nano-workforce/commit/5ad24bcadf833934804973a25fd96f4eb4d28a84)), closes [#354](https://github.com/nanobpm/nano-workforce/issues/354) [#354](https://github.com/nanobpm/nano-workforce/issues/354)

# [0.105.0](https://github.com/nanobpm/nano-workforce/compare/v0.104.0...v0.105.0) (2026-08-19)


### Features

* examine epic implementation against spec in retro (conformance) ([#355](https://github.com/nanobpm/nano-workforce/issues/355)) ([c52d059](https://github.com/nanobpm/nano-workforce/commit/c52d0594d767c551d31ed967d1ef79cb30e82ceb)), closes [#217](https://github.com/nanobpm/nano-workforce/issues/217) [#216](https://github.com/nanobpm/nano-workforce/issues/216) [#217](https://github.com/nanobpm/nano-workforce/issues/217)

# [0.104.0](https://github.com/nanobpm/nano-workforce/compare/v0.103.0...v0.104.0) (2026-08-19)


### Features

* **durable-resume:** enrolment gate + re-lease world-restore wiring ([#325](https://github.com/nanobpm/nano-workforce/issues/325)) ([#351](https://github.com/nanobpm/nano-workforce/issues/351)) ([b495dfa](https://github.com/nanobpm/nano-workforce/commit/b495dfabfda3e9e0953c6637342b79ca0c8148cc))

# [0.103.0](https://github.com/nanobpm/nano-workforce/compare/v0.102.1...v0.103.0) (2026-08-19)


### Features

* **feature:** intake-time readiness gate for single-issue runs ([#295](https://github.com/nanobpm/nano-workforce/issues/295)) ([#349](https://github.com/nanobpm/nano-workforce/issues/349)) ([09b519b](https://github.com/nanobpm/nano-workforce/commit/09b519be9ff21c8821b3ec3e0687541710be718b)), closes [owner/repo#N](https://github.com/owner/repo/issues/N)

## [0.102.1](https://github.com/nanobpm/nano-workforce/compare/v0.102.0...v0.102.1) (2026-08-19)


### Bug Fixes

* **merge-loop:** re-attempt merge for stale/transient CI instead of paging a human ([#348](https://github.com/nanobpm/nano-workforce/issues/348)) ([#350](https://github.com/nanobpm/nano-workforce/issues/350)) ([87ce2d6](https://github.com/nanobpm/nano-workforce/commit/87ce2d69e893b4b0f965f481d6c247fb8fcb84e8))

# [0.102.0](https://github.com/nanobpm/nano-workforce/compare/v0.101.1...v0.102.0) (2026-08-19)


### Features

* **console:** merged-per-day burn-down/throughput chart ([#345](https://github.com/nanobpm/nano-workforce/issues/345)) ([d4b27a9](https://github.com/nanobpm/nano-workforce/commit/d4b27a9cad36217db7c8ffc49ef26e0f31fb688e)), closes [#344](https://github.com/nanobpm/nano-workforce/issues/344) [#290](https://github.com/nanobpm/nano-workforce/issues/290) [#337](https://github.com/nanobpm/nano-workforce/issues/337) [#339](https://github.com/nanobpm/nano-workforce/issues/339) [#340](https://github.com/nanobpm/nano-workforce/issues/340) [#338](https://github.com/nanobpm/nano-workforce/issues/338)

## [0.101.1](https://github.com/nanobpm/nano-workforce/compare/v0.101.0...v0.101.1) (2026-08-19)


### Bug Fixes

* **merge-loop:** abandon a closed-not-merged PR instead of escalating ([#342](https://github.com/nanobpm/nano-workforce/issues/342)) ([#343](https://github.com/nanobpm/nano-workforce/issues/343)) ([10ea6be](https://github.com/nanobpm/nano-workforce/commit/10ea6be0e23c9315dfb71a6c94958826a1795a8c)), closes [#350](https://github.com/nanobpm/nano-workforce/issues/350)

# [0.101.0](https://github.com/nanobpm/nano-workforce/compare/v0.100.0...v0.101.0) (2026-08-19)


### Features

* **world:** durable world-restore — c8ctl working-tree reconstruction + effect fence ([#324](https://github.com/nanobpm/nano-workforce/issues/324)) ([#337](https://github.com/nanobpm/nano-workforce/issues/337)) ([d2f7655](https://github.com/nanobpm/nano-workforce/commit/d2f76557027eddeed062208ebaeb8136f7b9b922)), closes [#nextSeqOn](https://github.com/nanobpm/nano-workforce/issues/nextSeqOn) [#nextSeqOn](https://github.com/nanobpm/nano-workforce/issues/nextSeqOn) [#nextSeqOn](https://github.com/nanobpm/nano-workforce/issues/nextSeqOn) [#appendEffect](https://github.com/nanobpm/nano-workforce/issues/appendEffect) [#isFenceCollision](https://github.com/nanobpm/nano-workforce/issues/isFenceCollision) [#appendEffect](https://github.com/nanobpm/nano-workforce/issues/appendEffect) [#reconcileApplied](https://github.com/nanobpm/nano-workforce/issues/reconcileApplied) [#nextSeqOn](https://github.com/nanobpm/nano-workforce/issues/nextSeqOn)

# [0.100.0](https://github.com/nanobpm/nano-workforce/compare/v0.99.1...v0.100.0) (2026-08-19)


### Features

* retire interim feature-run escalation/blocked surface ([#339](https://github.com/nanobpm/nano-workforce/issues/339)) ([525d0f7](https://github.com/nanobpm/nano-workforce/commit/525d0f7a7f9661f640899e4bdf1b32052cff4ed9)), closes [#305](https://github.com/nanobpm/nano-workforce/issues/305) [#310](https://github.com/nanobpm/nano-workforce/issues/310) [#332](https://github.com/nanobpm/nano-workforce/issues/332) [#332](https://github.com/nanobpm/nano-workforce/issues/332)

## [0.99.1](https://github.com/nanobpm/nano-workforce/compare/v0.99.0...v0.99.1) (2026-08-19)


### Bug Fixes

* **convergence-loop:** route every escalation arm through gw-escalated ([#333](https://github.com/nanobpm/nano-workforce/issues/333)) ([#340](https://github.com/nanobpm/nano-workforce/issues/340)) ([0ad7a5c](https://github.com/nanobpm/nano-workforce/commit/0ad7a5c08a659a0ca26dc48def8c024d21a3a53a)), closes [#329](https://github.com/nanobpm/nano-workforce/issues/329)

# [0.99.0](https://github.com/nanobpm/nano-workforce/compare/v0.98.1...v0.99.0) (2026-08-19)


### Features

* **review-loop:** re-express the review-ready wait on the ReadinessProbe gate ([#259](https://github.com/nanobpm/nano-workforce/issues/259)) ([#338](https://github.com/nanobpm/nano-workforce/issues/338)) ([4d86509](https://github.com/nanobpm/nano-workforce/commit/4d86509f1f55dd9b31417add323e04da5b574b3d)), closes [#258](https://github.com/nanobpm/nano-workforce/issues/258) [#258](https://github.com/nanobpm/nano-workforce/issues/258)

## [0.98.1](https://github.com/nanobpm/nano-workforce/compare/v0.98.0...v0.98.1) (2026-08-19)


### Bug Fixes

* **merge-loop:** transient 'Base branch was modified' merge race → bounded retry, not escalate ([#335](https://github.com/nanobpm/nano-workforce/issues/335)) ([4093d50](https://github.com/nanobpm/nano-workforce/commit/4093d50b0ecd1a226bcfe7a5ecca10ba1db0937a)), closes [#330](https://github.com/nanobpm/nano-workforce/issues/330) [#334](https://github.com/nanobpm/nano-workforce/issues/334)

# [0.98.0](https://github.com/nanobpm/nano-workforce/compare/v0.97.1...v0.98.0) (2026-08-19)


### Features

* host-orchestrated per-task capability barrier for epic dispatch ([#289](https://github.com/nanobpm/nano-workforce/issues/289)) ([#290](https://github.com/nanobpm/nano-workforce/issues/290)) ([bb2f4bf](https://github.com/nanobpm/nano-workforce/commit/bb2f4bffb04b63d3b43bdec762d37770d03b1efb)), closes [263/#274](https://github.com/nanobpm/nano-workforce/issues/274)

## [0.97.1](https://github.com/nanobpm/nano-workforce/compare/v0.97.0...v0.97.1) (2026-08-19)


### Bug Fixes

* **merge-loop:** give merge-blocked escalation a question + gw-escalated guard ([#329](https://github.com/nanobpm/nano-workforce/issues/329)) ([#331](https://github.com/nanobpm/nano-workforce/issues/331)) ([abb2952](https://github.com/nanobpm/nano-workforce/commit/abb2952b5ff5874ff928085167f4a0fd5f0580e5))

# [0.97.0](https://github.com/nanobpm/nano-workforce/compare/v0.96.1...v0.97.0) (2026-08-19)


### Features

* **nav:** live open-tasks count badge on the Tasks nav item ([#306](https://github.com/nanobpm/nano-workforce/issues/306)) ([#330](https://github.com/nanobpm/nano-workforce/issues/330)) ([10aa55a](https://github.com/nanobpm/nano-workforce/commit/10aa55af9a3d5c60f13391f9e17361b6b33ac653)), closes [nano-ide#338](https://github.com/nano-ide/issues/338) [nano-ide#342](https://github.com/nano-ide/issues/342)

## [0.96.1](https://github.com/nanobpm/nano-workforce/compare/v0.96.0...v0.96.1) (2026-08-19)


### Bug Fixes

* **pages:** redesign the Epics table to a lean 6-column list ([#327](https://github.com/nanobpm/nano-workforce/issues/327)) ([#328](https://github.com/nanobpm/nano-workforce/issues/328)) ([b5842b3](https://github.com/nanobpm/nano-workforce/commit/b5842b33c89abb2db0aa6161fdddf32293452771)), closes [#87](https://github.com/nanobpm/nano-workforce/issues/87)

# [0.96.0](https://github.com/nanobpm/nano-workforce/compare/v0.95.0...v0.96.0) (2026-08-19)


### Features

* **escalations:** consolidate on native user_tasks — expand half (issue [#305](https://github.com/nanobpm/nano-workforce/issues/305)) ([#310](https://github.com/nanobpm/nano-workforce/issues/310)) ([fc5f4d4](https://github.com/nanobpm/nano-workforce/commit/fc5f4d4680223d0c7ca4572a7f883ce4257a26a5)), closes [nano-ide#333](https://github.com/nano-ide/issues/333)

# [0.95.0](https://github.com/nanobpm/nano-workforce/compare/v0.94.0...v0.95.0) (2026-08-19)


### Features

* **pages:** render "Updated" columns in the viewer's local time ([#302](https://github.com/nanobpm/nano-workforce/issues/302)) ([a73504d](https://github.com/nanobpm/nano-workforce/commit/a73504d6d6ebc968f21fa0f49eebf72774aa4b51)), closes [nano-ide#327](https://github.com/nano-ide/issues/327) [nano-ide#329](https://github.com/nano-ide/issues/329) [#301](https://github.com/nanobpm/nano-workforce/issues/301) [nano-ide#329](https://github.com/nano-ide/issues/329)

# [0.94.0](https://github.com/nanobpm/nano-workforce/compare/v0.93.0...v0.94.0) (2026-08-19)


### Features

* **pages:** feature-runs current stage links to the process instance ([#316](https://github.com/nanobpm/nano-workforce/issues/316)) ([4984f13](https://github.com/nanobpm/nano-workforce/commit/4984f13c1a3bd101499763731843ee4807bec49e)), closes [#315](https://github.com/nanobpm/nano-workforce/issues/315) [nano-ide#347](https://github.com/nano-ide/issues/347) [nanobpm/nano-ide#348](https://github.com/nanobpm/nano-ide/issues/348) [#311](https://github.com/nanobpm/nano-workforce/issues/311) [#307](https://github.com/nanobpm/nano-workforce/issues/307)

# [0.93.0](https://github.com/nanobpm/nano-workforce/compare/v0.92.0...v0.93.0) (2026-08-19)


### Features

* enforce scope-integrity guards in the review-convergence loop ([#314](https://github.com/nanobpm/nano-workforce/issues/314)) ([0a2a012](https://github.com/nanobpm/nano-workforce/commit/0a2a012b5d11e129de27633f1ef8508bc0fb457b)), closes [#631](https://github.com/nanobpm/nano-workforce/issues/631) [#863](https://github.com/nanobpm/nano-workforce/issues/863) [#872](https://github.com/nanobpm/nano-workforce/issues/872) [#N](https://github.com/nanobpm/nano-workforce/issues/N) [#N](https://github.com/nanobpm/nano-workforce/issues/N) [#N](https://github.com/nanobpm/nano-workforce/issues/N) [#313](https://github.com/nanobpm/nano-workforce/issues/313) [#N](https://github.com/nanobpm/nano-workforce/issues/N) [owner/repo#N](https://github.com/owner/repo/issues/N)

# [0.92.0](https://github.com/nanobpm/nano-workforce/compare/v0.91.0...v0.92.0) (2026-08-19)


### Bug Fixes

* **e2e:** polyfill EngineClient.openUserTasks in the testkit shim ([#309](https://github.com/nanobpm/nano-workforce/issues/309)) ([#312](https://github.com/nanobpm/nano-workforce/issues/312)) ([22609d5](https://github.com/nanobpm/nano-workforce/commit/22609d57789d09a1062cf8388b37a76ef293d4f0)), closes [#297](https://github.com/nanobpm/nano-workforce/issues/297) [#294](https://github.com/nanobpm/nano-workforce/issues/294)


### Features

* **epics:** bucket epics on delivery, not raw status, with a dismiss affordance ([#303](https://github.com/nanobpm/nano-workforce/issues/303)) ([4f9bd1a](https://github.com/nanobpm/nano-workforce/commit/4f9bd1a6d2853ffeacbdd6b744d9dd4efffba0ea)), closes [#298](https://github.com/nanobpm/nano-workforce/issues/298) [#298](https://github.com/nanobpm/nano-workforce/issues/298)

# [0.91.0](https://github.com/nanobpm/nano-workforce/compare/v0.90.0...v0.91.0) (2026-08-19)


### Features

* **tasks:** show subject title with repo/issue# as subtitle ([#308](https://github.com/nanobpm/nano-workforce/issues/308)) ([#311](https://github.com/nanobpm/nano-workforce/issues/311)) ([5771b38](https://github.com/nanobpm/nano-workforce/commit/5771b38abc33f4f88329d69c808214dfd42f5113))

# [0.90.0](https://github.com/nanobpm/nano-workforce/compare/v0.89.0...v0.90.0) (2026-08-19)


### Features

* **convergence:** surface epic / cross-slice lineage on the PR-row detail ([#307](https://github.com/nanobpm/nano-workforce/issues/307)) ([7010b88](https://github.com/nanobpm/nano-workforce/commit/7010b88889529aec173c552bab2a1e7b881ba9da)), closes [nanobpm/nano-workforce#304](https://github.com/nanobpm/nano-workforce/issues/304)

# [0.89.0](https://github.com/nanobpm/nano-workforce/compare/v0.88.1...v0.89.0) (2026-08-19)


### Features

* auto-open the epic integration-branch → default-branch promotion PR on landing ([#299](https://github.com/nanobpm/nano-workforce/issues/299)) ([#300](https://github.com/nanobpm/nano-workforce/issues/300)) ([24a8854](https://github.com/nanobpm/nano-workforce/commit/24a885484ae69bd654edd4d05fa198561e2db5dd))

## [0.88.1](https://github.com/nanobpm/nano-workforce/compare/v0.88.0...v0.88.1) (2026-08-18)


### Bug Fixes

* scope user-task pollers to open tasks so they can't latch a COMPLETED task ([#297](https://github.com/nanobpm/nano-workforce/issues/297)) ([131a796](https://github.com/nanobpm/nano-workforce/commit/131a796dfaed8f9b2eb25526f6583b86b8d7b0df)), closes [#294](https://github.com/nanobpm/nano-workforce/issues/294)

# [0.88.0](https://github.com/nanobpm/nano-workforce/compare/v0.87.0...v0.88.0) (2026-08-18)


### Features

* **service:** branch-scoped treeless clone for review-job repo envelope ([#287](https://github.com/nanobpm/nano-workforce/issues/287)) ([#288](https://github.com/nanobpm/nano-workforce/issues/288)) ([c90dc23](https://github.com/nanobpm/nano-workforce/commit/c90dc23274fbb5e19835e25eef755f88337ab86f)), closes [jwulf/c8ctl-plugin-nano#91](https://github.com/jwulf/c8ctl-plugin-nano/issues/91)

# [0.87.0](https://github.com/nanobpm/nano-workforce/compare/v0.86.0...v0.87.0) (2026-08-18)


### Features

* **agentic:** frictionless zero-config cockpit — LOCAL mode accepts a tokenless upgrade ([#283](https://github.com/nanobpm/nano-workforce/issues/283)) ([b23dfbb](https://github.com/nanobpm/nano-workforce/commit/b23dfbb018241e4719c6ea664f6428d094069aa6)), closes [#278](https://github.com/nanobpm/nano-workforce/issues/278) [#224](https://github.com/nanobpm/nano-workforce/issues/224) [#282](https://github.com/nanobpm/nano-workforce/issues/282)

# [0.86.0](https://github.com/nanobpm/nano-workforce/compare/v0.85.3...v0.86.0) (2026-08-18)


### Features

* **agentic:** enrolment hub — crew vocab, capability→SERVE & demand×supply board ([#152](https://github.com/nanobpm/nano-workforce/issues/152)) ([#281](https://github.com/nanobpm/nano-workforce/issues/281)) ([baf74e7](https://github.com/nanobpm/nano-workforce/commit/baf74e736a53af55883a78dcf1f84cc1d6c140c7)), closes [#145](https://github.com/nanobpm/nano-workforce/issues/145) [red/#blue](https://github.com/nanobpm/nano-workforce/issues/blue) [#153](https://github.com/nanobpm/nano-workforce/issues/153) [#red](https://github.com/nanobpm/nano-workforce/issues/red) [#blue](https://github.com/nanobpm/nano-workforce/issues/blue) [#145](https://github.com/nanobpm/nano-workforce/issues/145) [#153](https://github.com/nanobpm/nano-workforce/issues/153) [#board-root](https://github.com/nanobpm/nano-workforce/issues/board-root)

## [0.85.3](https://github.com/nanobpm/nano-workforce/compare/v0.85.2...v0.85.3) (2026-08-18)


### Bug Fixes

* resolve cockpit endpoints base-relative so Studio App-View populates ([#280](https://github.com/nanobpm/nano-workforce/issues/280)) ([eb7b69b](https://github.com/nanobpm/nano-workforce/commit/eb7b69bf5e3df192205e5ac227e36a01ceb71a2b)), closes [#279](https://github.com/nanobpm/nano-workforce/issues/279)

## [0.85.2](https://github.com/nanobpm/nano-workforce/compare/v0.85.1...v0.85.2) (2026-08-18)


### Bug Fixes

* **agentic:** open LOCAL channel on trusted LAN, drop unverified capability credential ([#278](https://github.com/nanobpm/nano-workforce/issues/278)) ([dc1e37a](https://github.com/nanobpm/nano-workforce/commit/dc1e37a8771beeb18e7e66b36bcfaffa498ed509))

## [0.85.1](https://github.com/nanobpm/nano-workforce/compare/v0.85.0...v0.85.1) (2026-08-18)


### Bug Fixes

* **deps:** bump @nanobpm/urban to ^0.55.0 ([#276](https://github.com/nanobpm/nano-workforce/issues/276)) ([08fe794](https://github.com/nanobpm/nano-workforce/commit/08fe794280c32e5a63cc4fd5a166dd4e35c1b8e8)), closes [276/#277](https://github.com/nanobpm/nano-workforce/issues/277)

# [0.85.0](https://github.com/nanobpm/nano-workforce/compare/v0.84.0...v0.85.0) (2026-08-17)


### Features

* **readiness:** capability probe kind — resolve capability→version from publish provenance, late-bind + pin ([#274](https://github.com/nanobpm/nano-workforce/issues/274)) ([#275](https://github.com/nanobpm/nano-workforce/issues/275)) ([33171b7](https://github.com/nanobpm/nano-workforce/commit/33171b73a69d5b130f205be12e7f0988b3f268a6)), closes [#258](https://github.com/nanobpm/nano-workforce/issues/258)

# [0.84.0](https://github.com/nanobpm/nano-workforce/compare/v0.83.0...v0.84.0) (2026-08-17)


### Features

* **ui:** render narrative epic-detail sections with urban prose renderer ([#270](https://github.com/nanobpm/nano-workforce/issues/270)) ([#271](https://github.com/nanobpm/nano-workforce/issues/271)) ([38c67a4](https://github.com/nanobpm/nano-workforce/commit/38c67a479693730b9a79f3a7b0f88ef574d3a456)), closes [nano-ide#274](https://github.com/nano-ide/issues/274) [#87](https://github.com/nanobpm/nano-workforce/issues/87) [274/#275](https://github.com/nanobpm/nano-workforce/issues/275)

# [0.83.0](https://github.com/nanobpm/nano-workforce/compare/v0.82.1...v0.83.0) (2026-08-17)


### Features

* **feature-view:** release intent-first pipeline view with stage chips ([0342edb](https://github.com/nanobpm/nano-workforce/commit/0342edbf67372450d6c499c1d39dc042e8dda342)), closes [#267](https://github.com/nanobpm/nano-workforce/issues/267) [#266](https://github.com/nanobpm/nano-workforce/issues/266)

## [0.82.1](https://github.com/nanobpm/nano-workforce/compare/v0.82.0...v0.82.1) (2026-08-17)


### Bug Fixes

* **plan-fanout:** make the wave-merge barrier level-triggered ([#262](https://github.com/nanobpm/nano-workforce/issues/262)) ([#264](https://github.com/nanobpm/nano-workforce/issues/264)) ([ae939d8](https://github.com/nanobpm/nano-workforce/commit/ae939d8e96f136f820fcae9149c120806ddc6f1b))

# [0.82.0](https://github.com/nanobpm/nano-workforce/compare/v0.81.0...v0.82.0) (2026-08-17)


### Features

* reify epic domain lifecycle as derived plans.epic_phase ([#261](https://github.com/nanobpm/nano-workforce/issues/261)) ([#265](https://github.com/nanobpm/nano-workforce/issues/265)) ([4cc9dee](https://github.com/nanobpm/nano-workforce/commit/4cc9deee86b800206d264d96269e6a98e8753883)), closes [#266](https://github.com/nanobpm/nano-workforce/issues/266) [nwf#245](https://github.com/nwf/issues/245) [nano-ide#254](https://github.com/nano-ide/issues/254)

# [0.81.0](https://github.com/nanobpm/nano-workforce/compare/v0.80.0...v0.81.0) (2026-08-17)


### Features

* durable artifact-readiness wait-gate primitive (ADR 0001 §2) ([#260](https://github.com/nanobpm/nano-workforce/issues/260)) ([e787488](https://github.com/nanobpm/nano-workforce/commit/e787488c074b9e4e44946a4144b814b34caffe57)), closes [#258](https://github.com/nanobpm/nano-workforce/issues/258) [#259](https://github.com/nanobpm/nano-workforce/issues/259) [#258](https://github.com/nanobpm/nano-workforce/issues/258)

# [0.80.0](https://github.com/nanobpm/nano-workforce/compare/v0.79.0...v0.80.0) (2026-08-17)


### Features

* thread request→PR lineage and project intent→progress ([#245](https://github.com/nanobpm/nano-workforce/issues/245)) ([#253](https://github.com/nanobpm/nano-workforce/issues/253)) ([b603276](https://github.com/nanobpm/nano-workforce/commit/b603276ce65500b351293497e9af7a3e899d73e5))

# [0.79.0](https://github.com/nanobpm/nano-workforce/compare/v0.78.0...v0.79.0) (2026-08-17)


### Features

* **agentic:** event-sourced transcripts — typed vocabulary + derive fold + replay-by-fork ([#251](https://github.com/nanobpm/nano-workforce/issues/251)) ([#252](https://github.com/nanobpm/nano-workforce/issues/252)) ([afa7190](https://github.com/nanobpm/nano-workforce/commit/afa7190db2c19e088ae3fb058a2b43d72f54a8df)), closes [146/#222](https://github.com/nanobpm/nano-workforce/issues/222)

# [0.78.0](https://github.com/nanobpm/nano-workforce/compare/v0.77.0...v0.78.0) (2026-08-17)


### Features

* converge the merge-loop escalation onto one native user-task pathway ([#256](https://github.com/nanobpm/nano-workforce/issues/256)) ([#257](https://github.com/nanobpm/nano-workforce/issues/257)) ([16551ee](https://github.com/nanobpm/nano-workforce/commit/16551ee59015081dcf20294ffdd05a078564b775))

# [0.77.0](https://github.com/nanobpm/nano-workforce/compare/v0.76.0...v0.77.0) (2026-08-17)


### Features

* bind the app to all interfaces so a remote worker fleet can reach it ([#224](https://github.com/nanobpm/nano-workforce/issues/224)) ([#255](https://github.com/nanobpm/nano-workforce/issues/255)) ([5968717](https://github.com/nanobpm/nano-workforce/commit/5968717416e13ff739b797822eb0d44ff51cc9cb)), closes [12778/#828](https://github.com/nanobpm/nano-workforce/issues/828) [12801/#252](https://github.com/nanobpm/nano-workforce/issues/252) [#228](https://github.com/nanobpm/nano-workforce/issues/228)

# [0.76.0](https://github.com/nanobpm/nano-workforce/compare/v0.75.0...v0.76.0) (2026-08-17)


### Features

* **ui:** adopt urban 0.52.0 dataGrid subtitle/width/truncate on identity grids ([#250](https://github.com/nanobpm/nano-workforce/issues/250)) ([abcae46](https://github.com/nanobpm/nano-workforce/commit/abcae4678e9b2a481372df3a42bc0ddedaa671b3)), closes [#260](https://github.com/nanobpm/nano-workforce/issues/260) [#259](https://github.com/nanobpm/nano-workforce/issues/259) [owner/repo#N](https://github.com/owner/repo/issues/N) [#248](https://github.com/nanobpm/nano-workforce/issues/248) [#249](https://github.com/nanobpm/nano-workforce/issues/249) [#259](https://github.com/nanobpm/nano-workforce/issues/259)

# [0.75.0](https://github.com/nanobpm/nano-workforce/compare/v0.74.0...v0.75.0) (2026-08-17)


### Features

* surface issue/PR titles on dispatch surfaces ([#248](https://github.com/nanobpm/nano-workforce/issues/248)) ([#249](https://github.com/nanobpm/nano-workforce/issues/249)) ([a63f6dd](https://github.com/nanobpm/nano-workforce/commit/a63f6dd9bab3040cdc61c807bdc999ce9a591299))

# [0.74.0](https://github.com/nanobpm/nano-workforce/compare/v0.73.1...v0.74.0) (2026-08-16)


### Features

* **feature:** thread optional custom instructions to the implementation agent ([#247](https://github.com/nanobpm/nano-workforce/issues/247)) ([8b65495](https://github.com/nanobpm/nano-workforce/commit/8b65495a739b01560937fa108ed4def16c3ffd85))

## [0.73.1](https://github.com/nanobpm/nano-workforce/compare/v0.73.0...v0.73.1) (2026-08-16)


### Bug Fixes

* **merge:** treat a Depends-on ref that is not a PR as non-blocking ([#246](https://github.com/nanobpm/nano-workforce/issues/246)) ([c800f81](https://github.com/nanobpm/nano-workforce/commit/c800f81b02b3a9a787d79552f4e5eef9971e3edf)), closes [Magikcraft/nano-bpm#806](https://github.com/Magikcraft/nano-bpm/issues/806)

# [0.73.0](https://github.com/nanobpm/nano-workforce/compare/v0.72.1...v0.73.0) (2026-08-15)


### Features

* **deploy:** resources/ deploy-by-convention; drop models; docs→docs/ (ADR 0062 step 3) ([#241](https://github.com/nanobpm/nano-workforce/issues/241)) ([9f7f85c](https://github.com/nanobpm/nano-workforce/commit/9f7f85c1231ce228c4468ac8f5222dd14d84022b)), closes [nanobpm/nano-ide#244](https://github.com/nanobpm/nano-ide/issues/244) [#244](https://github.com/nanobpm/nano-workforce/issues/244) [#239](https://github.com/nanobpm/nano-workforce/issues/239) [nanobpm/nano-ide#244](https://github.com/nanobpm/nano-ide/issues/244) [nanobpm/nano-workforce#239](https://github.com/nanobpm/nano-workforce/issues/239)

## [0.72.1](https://github.com/nanobpm/nano-workforce/compare/v0.72.0...v0.72.1) (2026-08-15)


### Bug Fixes

* remove question from table ([#240](https://github.com/nanobpm/nano-workforce/issues/240)) ([d672206](https://github.com/nanobpm/nano-workforce/commit/d6722063c3110672f8e2f0ee8c955c7ab0b39577))

# [0.72.0](https://github.com/nanobpm/nano-workforce/compare/v0.71.0...v0.72.0) (2026-08-15)


### Features

* coordinate shared contracts via a durable registry + blackboard signal + reconciliation pass ([#229](https://github.com/nanobpm/nano-workforce/issues/229)) ([2c250b5](https://github.com/nanobpm/nano-workforce/commit/2c250b51596e1a062c4e09c6aef638010abea793)), closes [#223](https://github.com/nanobpm/nano-workforce/issues/223) [#234](https://github.com/nanobpm/nano-workforce/issues/234) [214/#217](https://github.com/nanobpm/nano-workforce/issues/217) [#223](https://github.com/nanobpm/nano-workforce/issues/223) [#227](https://github.com/nanobpm/nano-workforce/issues/227) [#227](https://github.com/nanobpm/nano-workforce/issues/227)

# [0.71.0](https://github.com/nanobpm/nano-workforce/compare/v0.70.2...v0.71.0) (2026-08-15)


### Features

* add a Tasks page to resolve native user-task escalations in the UI ([#238](https://github.com/nanobpm/nano-workforce/issues/238)) ([4dcd1a1](https://github.com/nanobpm/nano-workforce/commit/4dcd1a1ca1756bec45997ce619ed92bff31d03d6)), closes [210/#220](https://github.com/nanobpm/nano-workforce/issues/220)

## [0.70.2](https://github.com/nanobpm/nano-workforce/compare/v0.70.1...v0.70.2) (2026-08-15)


### Bug Fixes

* **merge-loop:** add agent-task liveness SLA backstop for rebase/fix-ci ([#237](https://github.com/nanobpm/nano-workforce/issues/237)) ([c77cdca](https://github.com/nanobpm/nano-workforce/commit/c77cdca974a1e53ef2f9757cc5cedf95068713f1))

## [0.70.1](https://github.com/nanobpm/nano-workforce/compare/v0.70.0...v0.70.1) (2026-08-15)


### Bug Fixes

* **convergence:** don't re-review a no-progress round ([#230](https://github.com/nanobpm/nano-workforce/issues/230)) ([a8ea844](https://github.com/nanobpm/nano-workforce/commit/a8ea84444b351989f716124d0b485b42e1ec2a35)), closes [#231](https://github.com/nanobpm/nano-workforce/issues/231) [Magikcraft/nano-bpm#770](https://github.com/Magikcraft/nano-bpm/issues/770) [#770](https://github.com/nanobpm/nano-workforce/issues/770) [nanobpm/nano-workforce#225](https://github.com/nanobpm/nano-workforce/issues/225) [#2](https://github.com/nanobpm/nano-workforce/issues/2) [#770](https://github.com/nanobpm/nano-workforce/issues/770)

# [0.70.0](https://github.com/nanobpm/nano-workforce/compare/v0.69.1...v0.70.0) (2026-08-15)


### Features

* **agentic:** transcript read path + cockpit past-session replay ([#222](https://github.com/nanobpm/nano-workforce/issues/222)) ([#225](https://github.com/nanobpm/nano-workforce/issues/225)) ([a93cdd0](https://github.com/nanobpm/nano-workforce/commit/a93cdd0824a3afcb44feffdb2dafc7732154545e)), closes [#refreshPast](https://github.com/nanobpm/nano-workforce/issues/refreshPast) [mode/#shownStream](https://github.com/nanobpm/nano-workforce/issues/shownStream) [#refreshPast](https://github.com/nanobpm/nano-workforce/issues/refreshPast)

## [0.69.1](https://github.com/nanobpm/nano-workforce/compare/v0.69.0...v0.69.1) (2026-08-15)


### Bug Fixes

* **models:** add required resourceType to all linkedResources ([#234](https://github.com/nanobpm/nano-workforce/issues/234)) ([#235](https://github.com/nanobpm/nano-workforce/issues/235)) ([a3ac02f](https://github.com/nanobpm/nano-workforce/commit/a3ac02f308c813a778682ace21718f4f7e446c52)), closes [Magikcraft/nano-bpm#768](https://github.com/Magikcraft/nano-bpm/issues/768) [#768](https://github.com/nanobpm/nano-workforce/issues/768)

# [0.69.0](https://github.com/nanobpm/nano-workforce/compare/v0.68.0...v0.69.0) (2026-08-15)


### Features

* **agentic:** enable nwf for a remote fleet — loopback-guard the LOCAL token + document network posture ([#224](https://github.com/nanobpm/nano-workforce/issues/224)) ([#228](https://github.com/nanobpm/nano-workforce/issues/228)) ([73f6170](https://github.com/nanobpm/nano-workforce/commit/73f6170ff4c0df0ad6c4eb2a2e6e9b3df5d1e343)), closes [nano-ide#235](https://github.com/nano-ide/issues/235) [nano-ide#235](https://github.com/nano-ide/issues/235)

# [0.68.0](https://github.com/nanobpm/nano-workforce/compare/v0.67.0...v0.68.0) (2026-08-14)


### Features

* **feature:** UI completion affordance for blocked feature runs ([#220](https://github.com/nanobpm/nano-workforce/issues/220)) ([#221](https://github.com/nanobpm/nano-workforce/issues/221)) ([5b68ad4](https://github.com/nanobpm/nano-workforce/commit/5b68ad4871e21d59224d69cde0b95f02247884ae)), closes [#210](https://github.com/nanobpm/nano-workforce/issues/210)

# [0.67.0](https://github.com/nanobpm/nano-workforce/compare/v0.66.0...v0.67.0) (2026-08-14)


### Features

* **agentic:** local-first visibility — on by default, security opt-in (hub) ([#218](https://github.com/nanobpm/nano-workforce/issues/218)) ([ffef1d9](https://github.com/nanobpm/nano-workforce/commit/ffef1d9819679cb6995ad2d2825bce5c6cabccb5)), closes [jwulf/c8ctl-plugin-nano#38](https://github.com/jwulf/c8ctl-plugin-nano/issues/38)

# [0.66.0](https://github.com/nanobpm/nano-workforce/compare/v0.65.0...v0.66.0) (2026-08-14)


### Features

* derive record-plan/record-wave/record-trial-merge array inputs from the model ([#212](https://github.com/nanobpm/nano-workforce/issues/212)) ([95f1694](https://github.com/nanobpm/nano-workforce/commit/95f16944918b99107e784eed5ab69a5962365ec4)), closes [#211](https://github.com/nanobpm/nano-workforce/issues/211) [#211](https://github.com/nanobpm/nano-workforce/issues/211) [#211](https://github.com/nanobpm/nano-workforce/issues/211) [#211](https://github.com/nanobpm/nano-workforce/issues/211)

# [0.65.0](https://github.com/nanobpm/nano-workforce/compare/v0.64.0...v0.65.0) (2026-08-13)


### Features

* surface native feature-run escalations in the nwf UI ([#213](https://github.com/nanobpm/nano-workforce/issues/213)) ([cf14724](https://github.com/nanobpm/nano-workforce/commit/cf1472419e2c68be4902a1fce2dabfcf39f2ae54)), closes [#210](https://github.com/nanobpm/nano-workforce/issues/210) [#210](https://github.com/nanobpm/nano-workforce/issues/210)

# [0.64.0](https://github.com/nanobpm/nano-workforce/compare/v0.63.0...v0.64.0) (2026-08-13)


### Features

* type workers off the generated data envelope ([#201](https://github.com/nanobpm/nano-workforce/issues/201)) ([#208](https://github.com/nanobpm/nano-workforce/issues/208)) ([792083f](https://github.com/nanobpm/nano-workforce/commit/792083f153050862a11224288b0e27e769ab06ba)), closes [nano-ide#225](https://github.com/nano-ide/issues/225) [#225](https://github.com/nanobpm/nano-workforce/issues/225) [#228](https://github.com/nanobpm/nano-workforce/issues/228) [#211](https://github.com/nanobpm/nano-workforce/issues/211) [#211](https://github.com/nanobpm/nano-workforce/issues/211)

# [0.63.0](https://github.com/nanobpm/nano-workforce/compare/v0.62.0...v0.63.0) (2026-08-13)


### Features

* Overview landing page with collapsible active-work sections ([#206](https://github.com/nanobpm/nano-workforce/issues/206)) ([64c91df](https://github.com/nanobpm/nano-workforce/commit/64c91dfacd6b9b660a7bbbb1a3c9a8a78603b247)), closes [nanobpm/nano-ide#227](https://github.com/nanobpm/nano-ide/issues/227) [#205](https://github.com/nanobpm/nano-workforce/issues/205)

# [0.62.0](https://github.com/nanobpm/nano-workforce/compare/v0.61.1...v0.62.0) (2026-08-13)


### Features

* **feature-prompt:** claim the issue with a comment before starting work ([#207](https://github.com/nanobpm/nano-workforce/issues/207)) ([b1b23c9](https://github.com/nanobpm/nano-workforce/commit/b1b23c9928704616aa2173cfa056668a11d32e1c))

## [0.61.1](https://github.com/nanobpm/nano-workforce/compare/v0.61.0...v0.61.1) (2026-08-13)


### Bug Fixes

* **feature:** reconcile Feature-history status + escalate blocked runs ([#204](https://github.com/nanobpm/nano-workforce/issues/204)) ([5ef9461](https://github.com/nanobpm/nano-workforce/commit/5ef94613f09b557806eb9254545df1984025077c)), closes [#171](https://github.com/nanobpm/nano-workforce/issues/171)

# [0.61.0](https://github.com/nanobpm/nano-workforce/compare/v0.60.0...v0.61.0) (2026-08-13)


### Features

* prompts as linked resources (bindingType: latest) — live mid-epic updates ([#198](https://github.com/nanobpm/nano-workforce/issues/198)) ([#203](https://github.com/nanobpm/nano-workforce/issues/203)) ([24a83e0](https://github.com/nanobpm/nano-workforce/commit/24a83e01f7e7b4f6e5296ce90c63fa44105aa058)), closes [#169](https://github.com/nanobpm/nano-workforce/issues/169) [#169](https://github.com/nanobpm/nano-workforce/issues/169)

# [0.60.0](https://github.com/nanobpm/nano-workforce/compare/v0.59.0...v0.60.0) (2026-08-13)


### Features

* **pages:** mark required form fields for inline validation hints ([#199](https://github.com/nanobpm/nano-workforce/issues/199)) ([15f0038](https://github.com/nanobpm/nano-workforce/commit/15f003809d0ec3294415161a79d73ef53c2703f2)), closes [nano-ide#223](https://github.com/nano-ide/issues/223) [nano-ide#223](https://github.com/nano-ide/issues/223)

# [0.59.0](https://github.com/nanobpm/nano-workforce/compare/v0.58.1...v0.59.0) (2026-08-13)


### Features

* derive epic delivery signal (converging vs landed) ([#197](https://github.com/nanobpm/nano-workforce/issues/197)) ([39ab5f1](https://github.com/nanobpm/nano-workforce/commit/39ab5f1b2628aadd350e9043ab0114103a24a1e2)), closes [#171](https://github.com/nanobpm/nano-workforce/issues/171) [#171](https://github.com/nanobpm/nano-workforce/issues/171)

## [0.58.1](https://github.com/nanobpm/nano-workforce/compare/v0.58.0...v0.58.1) (2026-08-13)


### Bug Fixes

* regenerate nano-generated/ before start (prestart: urban gen) ([#195](https://github.com/nanobpm/nano-workforce/issues/195)) ([d45fe22](https://github.com/nanobpm/nano-workforce/commit/d45fe22de58766730721f51cbcb7e97d6f4f06c8)), closes [#192](https://github.com/nanobpm/nano-workforce/issues/192)

# [0.58.0](https://github.com/nanobpm/nano-workforce/compare/v0.57.0...v0.58.0) (2026-08-13)


### Features

* single-issue feature run — one issue → one PR (+ optional converge/merge) ([#194](https://github.com/nanobpm/nano-workforce/issues/194)) ([7557439](https://github.com/nanobpm/nano-workforce/commit/7557439e7f88383a5da62fda45994a37f6262007)), closes [post-#192](https://github.com/post-/issues/192) [#172](https://github.com/nanobpm/nano-workforce/issues/172) [#172](https://github.com/nanobpm/nano-workforce/issues/172) [owner/repo#N](https://github.com/owner/repo/issues/N)

# [0.57.0](https://github.com/nanobpm/nano-workforce/compare/v0.56.0...v0.57.0) (2026-08-13)


### Features

* **app-view:** show epic base branch in epics overview grid ([#159](https://github.com/nanobpm/nano-workforce/issues/159)) ([#164](https://github.com/nanobpm/nano-workforce/issues/164)) ([216cb0f](https://github.com/nanobpm/nano-workforce/commit/216cb0f515561fbaa646725593707ae6a2418246))

# [0.56.0](https://github.com/nanobpm/nano-workforce/compare/v0.55.0...v0.56.0) (2026-08-13)


### Features

* correlate jobKeys to process/plan across supply report + cockpit (H6) ([#182](https://github.com/nanobpm/nano-workforce/issues/182)) ([f6e2b0d](https://github.com/nanobpm/nano-workforce/commit/f6e2b0d5f804c4c30863e5f5c66bbdc835025046)), closes [#142](https://github.com/nanobpm/nano-workforce/issues/142) [#152](https://github.com/nanobpm/nano-workforce/issues/152) [#149](https://github.com/nanobpm/nano-workforce/issues/149)

# [0.55.0](https://github.com/nanobpm/nano-workforce/compare/v0.54.0...v0.55.0) (2026-08-13)


### Features

* supply-only agentic cockpit page + report endpoint (H5) ([#173](https://github.com/nanobpm/nano-workforce/issues/173)) ([428f7f3](https://github.com/nanobpm/nano-workforce/commit/428f7f3a8ca35ea05c8b9c0dbc478d24d125486a)), closes [#144](https://github.com/nanobpm/nano-workforce/issues/144) [#146](https://github.com/nanobpm/nano-workforce/issues/146) [#152](https://github.com/nanobpm/nano-workforce/issues/152) [#148](https://github.com/nanobpm/nano-workforce/issues/148) [#144](https://github.com/nanobpm/nano-workforce/issues/144) [#146](https://github.com/nanobpm/nano-workforce/issues/146)

# [0.54.0](https://github.com/nanobpm/nano-workforce/compare/v0.53.0...v0.54.0) (2026-08-13)


### Features

* generalize the advisory blackboard onto the agentic channel (H4) ([#166](https://github.com/nanobpm/nano-workforce/issues/166)) ([450a4fa](https://github.com/nanobpm/nano-workforce/commit/450a4fa4a75ad1cdc2a78eef6f95aa2f45bebb9f)), closes [#147](https://github.com/nanobpm/nano-workforce/issues/147) [#147](https://github.com/nanobpm/nano-workforce/issues/147) [#143](https://github.com/nanobpm/nano-workforce/issues/143)

# [0.53.0](https://github.com/nanobpm/nano-workforce/compare/v0.52.0...v0.53.0) (2026-08-13)


### Features

* relay ring + transcript store agentic family (H3) ([#162](https://github.com/nanobpm/nano-workforce/issues/162)) ([f629526](https://github.com/nanobpm/nano-workforce/commit/f62952698fa3cfb3321e60fdce61fdb1f13ca9d6)), closes [#142](https://github.com/nanobpm/nano-workforce/issues/142) [#143](https://github.com/nanobpm/nano-workforce/issues/143) [#146](https://github.com/nanobpm/nano-workforce/issues/146) [#streams](https://github.com/nanobpm/nano-workforce/issues/streams)

# [0.52.0](https://github.com/nanobpm/nano-workforce/compare/v0.51.0...v0.52.0) (2026-08-13)


### Features

* presence + registry family over app.data (H1) ([#161](https://github.com/nanobpm/nano-workforce/issues/161)) ([6666ff1](https://github.com/nanobpm/nano-workforce/commit/6666ff148d02bc0f7ae9740511fdc62bbe9c2e70)), closes [#142](https://github.com/nanobpm/nano-workforce/issues/142) [#152](https://github.com/nanobpm/nano-workforce/issues/152) [#152](https://github.com/nanobpm/nano-workforce/issues/152) [#144](https://github.com/nanobpm/nano-workforce/issues/144)

# [0.51.0](https://github.com/nanobpm/nano-workforce/compare/v0.50.0...v0.51.0) (2026-08-13)


### Features

* mount agentic channel hub + family-registration seam (H0) ([#154](https://github.com/nanobpm/nano-workforce/issues/154)) ([96a679e](https://github.com/nanobpm/nano-workforce/commit/96a679e0843c76bf93940f09eef1c6c642a4ebed)), closes [#142](https://github.com/nanobpm/nano-workforce/issues/142) [#143](https://github.com/nanobpm/nano-workforce/issues/143) [#isMounted](https://github.com/nanobpm/nano-workforce/issues/isMounted)

# [0.50.0](https://github.com/nanobpm/nano-workforce/compare/v0.49.0...v0.50.0) (2026-08-12)


### Features

* **merge:** adopt @nanobpm/urban/effect matchTags for exhaustive land dispatch ([#139](https://github.com/nanobpm/nano-workforce/issues/139)) ([c251763](https://github.com/nanobpm/nano-workforce/commit/c251763a050858ea610ce45e59a34f859163c29c)), closes [nano-ide#215](https://github.com/nano-ide/issues/215)

# [0.49.0](https://github.com/nanobpm/nano-workforce/compare/v0.48.2...v0.49.0) (2026-08-12)


### Features

* **ui:** per-epic operator workspace with live wave progress ([#138](https://github.com/nanobpm/nano-workforce/issues/138)) ([127888d](https://github.com/nanobpm/nano-workforce/commit/127888d5d2b66e1e9d1c85d015cbd65f3696216f)), closes [#137](https://github.com/nanobpm/nano-workforce/issues/137) [nanobpm/nano-workforce#137](https://github.com/nanobpm/nano-workforce/issues/137) [nanobpm/nano-ide#213](https://github.com/nanobpm/nano-ide/issues/213) [nanobpm/nano-ide#214](https://github.com/nanobpm/nano-ide/issues/214)

## [0.48.2](https://github.com/nanobpm/nano-workforce/compare/v0.48.1...v0.48.2) (2026-08-12)


### Bug Fixes

* **merge-loop:** reconcile from ground truth instead of escalating on a missing agent status ([#135](https://github.com/nanobpm/nano-workforce/issues/135)) ([6861cbe](https://github.com/nanobpm/nano-workforce/commit/6861cbe160d0aebb903924f5aaf67f9c90adac6d)), closes [#134](https://github.com/nanobpm/nano-workforce/issues/134)

## [0.48.1](https://github.com/nanobpm/nano-workforce/compare/v0.48.0...v0.48.1) (2026-08-12)


### Bug Fixes

* **ui:** remove duplicate "Plans (agent fleet)" section from the Convergence page ([#136](https://github.com/nanobpm/nano-workforce/issues/136)) ([7eb836a](https://github.com/nanobpm/nano-workforce/commit/7eb836a47888d5c29a716d15596bd8a2b29e448c))

# [0.48.0](https://github.com/nanobpm/nano-workforce/compare/v0.47.0...v0.48.0) (2026-08-12)


### Features

* **pages:** render PR incident as a red badge on the home grid ([#132](https://github.com/nanobpm/nano-workforce/issues/132)) ([7a58015](https://github.com/nanobpm/nano-workforce/commit/7a58015676b8d0ca6ec7b28c7943504b5f3dfb0e)), closes [#94](https://github.com/nanobpm/nano-workforce/issues/94)

# [0.47.0](https://github.com/nanobpm/nano-workforce/compare/v0.46.2...v0.47.0) (2026-08-12)


### Features

* **ui:** Agent Instructions button (copy-paste agent prompt) ([#126](https://github.com/nanobpm/nano-workforce/issues/126)) ([4c022ab](https://github.com/nanobpm/nano-workforce/commit/4c022abcbaa90501cacc27ac0b9c8d77b3f81df1)), closes [nanobpm/nano-ide#196](https://github.com/nanobpm/nano-ide/issues/196)

## [0.46.2](https://github.com/nanobpm/nano-workforce/compare/v0.46.1...v0.46.2) (2026-08-12)


### Bug Fixes

* **prompts:** make merge-phase agents emit a machine-readable result ([#133](https://github.com/nanobpm/nano-workforce/issues/133)) ([6584092](https://github.com/nanobpm/nano-workforce/commit/6584092b3ef8f15159c024c080b312ead7484076)), closes [Magikcraft/nano-bpm#746](https://github.com/Magikcraft/nano-bpm/issues/746)

## [0.46.1](https://github.com/nanobpm/nano-workforce/compare/v0.46.0...v0.46.1) (2026-08-12)


### Bug Fixes

* **trial-merge:** durable "needs attention" resolution + robust escalation key ([#131](https://github.com/nanobpm/nano-workforce/issues/131)) ([71200e8](https://github.com/nanobpm/nano-workforce/commit/71200e814a8c035a79f1eec37303781c70b6e6c0))

# [0.46.0](https://github.com/nanobpm/nano-workforce/compare/v0.45.0...v0.46.0) (2026-08-12)


### Features

* add plan review escalation ([#128](https://github.com/nanobpm/nano-workforce/issues/128)) ([b67cc9e](https://github.com/nanobpm/nano-workforce/commit/b67cc9ebd84ef251e38e1e0fc332f712f82438c2)), closes [owner/repo#N](https://github.com/owner/repo/issues/N)

# [0.45.0](https://github.com/nanobpm/nano-workforce/compare/v0.44.1...v0.45.0) (2026-08-12)


### Features

* **plan:** pin an epic's base branch so the fleet lands on an integration branch ([#125](https://github.com/nanobpm/nano-workforce/issues/125)) ([1c3bfa1](https://github.com/nanobpm/nano-workforce/commit/1c3bfa1a1dbc212e31e510931766f46904dae1a3)), closes [#124](https://github.com/nanobpm/nano-workforce/issues/124) [nanobpm/nano-workforce#124](https://github.com/nanobpm/nano-workforce/issues/124)

## [0.44.1](https://github.com/nanobpm/nano-workforce/compare/v0.44.0...v0.44.1) (2026-08-11)


### Bug Fixes

* provision isolated agent workspaces via the c8ctl repository envelope ([#124](https://github.com/nanobpm/nano-workforce/issues/124)) ([79c999b](https://github.com/nanobpm/nano-workforce/commit/79c999bc34dd7984ceffd7746a4538705565f2a5))

# [0.44.0](https://github.com/nanobpm/nano-workforce/compare/v0.43.0...v0.44.0) (2026-08-11)


### Features

* **merge-loop:** wait on a blocking PR instead of escalating to a human ([#122](https://github.com/nanobpm/nano-workforce/issues/122)) ([aec738f](https://github.com/nanobpm/nano-workforce/commit/aec738f165df5a216b9094b4eb9b5b6d4a7ac419))

# [0.43.0](https://github.com/nanobpm/nano-workforce/compare/v0.42.0...v0.43.0) (2026-08-11)


### Features

* **api:** oneOf request bodies + structured logging (urban 0.42.0) ([#120](https://github.com/nanobpm/nano-workforce/issues/120)) ([ea7549b](https://github.com/nanobpm/nano-workforce/commit/ea7549bd4acb7cdd874fde0a8ccccbf1563b8e53)), closes [#119](https://github.com/nanobpm/nano-workforce/issues/119)

# [0.42.0](https://github.com/nanobpm/nano-workforce/compare/v0.41.0...v0.42.0) (2026-08-11)


### Features

* **ui:** checkbox to run convergence without auto-merge ([#121](https://github.com/nanobpm/nano-workforce/issues/121)) ([8883026](https://github.com/nanobpm/nano-workforce/commit/8883026d552855c8a25c526d22ef2aa83ac9f298)), closes [#115](https://github.com/nanobpm/nano-workforce/issues/115)

# [0.41.0](https://github.com/nanobpm/nano-workforce/compare/v0.40.2...v0.41.0) (2026-08-11)


### Features

* **api:** serve an agent operator guide at GET /app/api/agent ([#118](https://github.com/nanobpm/nano-workforce/issues/118)) ([6768407](https://github.com/nanobpm/nano-workforce/commit/67684075cfe4706db7dfc63f8c536990254a7480))

## [0.40.2](https://github.com/nanobpm/nano-workforce/compare/v0.40.1...v0.40.2) (2026-08-11)


### Bug Fixes

* **merge-loop:** escape wait-landed when a queued PR is evicted on conflict ([#117](https://github.com/nanobpm/nano-workforce/issues/117)) ([df7f850](https://github.com/nanobpm/nano-workforce/commit/df7f85050624f11490d715c90e054a5c7fb6d0fa)), closes [Magikcraft/nano-bpm#727](https://github.com/Magikcraft/nano-bpm/issues/727)

## [0.40.1](https://github.com/nanobpm/nano-workforce/compare/v0.40.0...v0.40.1) (2026-08-11)


### Bug Fixes

* **convergence:** safe default for resultless review rounds ([#116](https://github.com/nanobpm/nano-workforce/issues/116)) ([de85188](https://github.com/nanobpm/nano-workforce/commit/de85188f57b69496596f4c41cf555c9f6f2090da))

# [0.40.0](https://github.com/nanobpm/nano-workforce/compare/v0.39.3...v0.40.0) (2026-08-11)


### Features

* **convergence:** per-request convergeOnly override to skip the merge-loop ([#115](https://github.com/nanobpm/nano-workforce/issues/115)) ([8840b23](https://github.com/nanobpm/nano-workforce/commit/8840b23e97ed56aaf43df20d3f9a97b00b7e865d))

## [0.39.3](https://github.com/nanobpm/nano-workforce/compare/v0.39.2...v0.39.3) (2026-08-11)


### Bug Fixes

* **merge-loop:** judge fresh-head-run by required checks, not rollup length ([#113](https://github.com/nanobpm/nano-workforce/issues/113)) ([a10c4c5](https://github.com/nanobpm/nano-workforce/commit/a10c4c5b3ee5c452591eeb6c6206c4815674959a))

## [0.39.2](https://github.com/nanobpm/nano-workforce/compare/v0.39.1...v0.39.2) (2026-08-11)


### Bug Fixes

* **merge:** recover PRs merged out-of-band instead of wedging in "merging" ([#112](https://github.com/nanobpm/nano-workforce/issues/112)) ([037d8aa](https://github.com/nanobpm/nano-workforce/commit/037d8aa2538b85f9c1b43927378f3578530a924e)), closes [Magikcraft/nano-bpm#723](https://github.com/Magikcraft/nano-bpm/issues/723)

## [0.39.1](https://github.com/nanobpm/nano-workforce/compare/v0.39.0...v0.39.1) (2026-08-10)


### Bug Fixes

* **openapi:** use 3.0 nullable idiom instead of 3.1 type-arrays ([#111](https://github.com/nanobpm/nano-workforce/issues/111)) ([28f40c8](https://github.com/nanobpm/nano-workforce/commit/28f40c891d48043ef7537158466bafdfb79b9792))

# [0.39.0](https://github.com/nanobpm/nano-workforce/compare/v0.38.0...v0.39.0) (2026-08-10)


### Features

* adopt urban 0.38.0 typed delegate registry for the OpenAPI surface ([#110](https://github.com/nanobpm/nano-workforce/issues/110)) ([fe62908](https://github.com/nanobpm/nano-workforce/commit/fe62908968c0bd707f8e2da58fa550cca9fbab5b))

# [0.38.0](https://github.com/nanobpm/nano-workforce/compare/v0.37.0...v0.38.0) (2026-08-10)


### Features

* migrate hooks to OpenAPI operations, one HTTP surface (ADR 0059) ([#109](https://github.com/nanobpm/nano-workforce/issues/109)) ([493d78c](https://github.com/nanobpm/nano-workforce/commit/493d78c5b58ba18098c7d458bd9538660eb2d0f3))

# [0.37.0](https://github.com/nanobpm/nano-workforce/compare/v0.36.0...v0.37.0) (2026-08-10)


### Features

* remove Deno — Node is the only runtime ([#108](https://github.com/nanobpm/nano-workforce/issues/108)) ([d077e9c](https://github.com/nanobpm/nano-workforce/commit/d077e9c94696e2030a2033ad53a05c86a4c18a3e)), closes [#test-assert](https://github.com/nanobpm/nano-workforce/issues/test-assert)

# [0.36.0](https://github.com/nanobpm/nano-workforce/compare/v0.35.2...v0.36.0) (2026-08-10)


### Features

* adopt Biome + GritQL ban-`as` lint gate ([#107](https://github.com/nanobpm/nano-workforce/issues/107)) ([38c16fb](https://github.com/nanobpm/nano-workforce/commit/38c16fb319e8c5d6b8c20faf95318de39b948a96)), closes [#105](https://github.com/nanobpm/nano-workforce/issues/105)

## [0.35.2](https://github.com/nanobpm/nano-workforce/compare/v0.35.1...v0.35.2) (2026-08-10)


### Bug Fixes

* **pages:** route-driven page actions via @nanobpm/urban@0.33.0 ([#106](https://github.com/nanobpm/nano-workforce/issues/106)) ([0ee4ab2](https://github.com/nanobpm/nano-workforce/commit/0ee4ab29aa8cfca6a04af6eb141a96d7878a6b1a))

## [0.35.1](https://github.com/nanobpm/nano-workforce/compare/v0.35.0...v0.35.1) (2026-08-10)


### Bug Fixes

* **api:** move OpenAPI base off the reserved /app page-runtime namespace ([#103](https://github.com/nanobpm/nano-workforce/issues/103)) ([6dfb77f](https://github.com/nanobpm/nano-workforce/commit/6dfb77ff82b532965c4a9823d771d46d4ffa920e)), closes [#102](https://github.com/nanobpm/nano-workforce/issues/102)

# [0.35.0](https://github.com/nanobpm/nano-workforce/compare/v0.34.0...v0.35.0) (2026-08-10)


### Features

* migrate externally-facing endpoints to the OpenAPI api surface ([#102](https://github.com/nanobpm/nano-workforce/issues/102)) ([5598e2c](https://github.com/nanobpm/nano-workforce/commit/5598e2ce5a8ec3dc241401714284ce8c94420f7a))

# [0.34.0](https://github.com/nanobpm/nano-workforce/compare/v0.33.1...v0.34.0) (2026-08-09)


### Features

* adopt @nanobpm/urban 0.31.0 (activate processExplorer status links) ([#101](https://github.com/nanobpm/nano-workforce/issues/101)) ([f2313ec](https://github.com/nanobpm/nano-workforce/commit/f2313ecd654b24860ae8f3f21eea791b4de290fb)), closes [#99](https://github.com/nanobpm/nano-workforce/issues/99) [#145](https://github.com/nanobpm/nano-workforce/issues/145) [#100](https://github.com/nanobpm/nano-workforce/issues/100)

## [0.33.1](https://github.com/nanobpm/nano-workforce/compare/v0.33.0...v0.33.1) (2026-08-09)


### Bug Fixes

* adopt Urban's built-in reconcile-aware cancel primitive ([#100](https://github.com/nanobpm/nano-workforce/issues/100)) ([e1aed94](https://github.com/nanobpm/nano-workforce/commit/e1aed94c29fc1ebd8ec0f5ca15d73e6ee723d276)), closes [nanobpm/nano-ide#144](https://github.com/nanobpm/nano-ide/issues/144)

# [0.33.0](https://github.com/nanobpm/nano-workforce/compare/v0.32.2...v0.33.0) (2026-08-09)


### Bug Fixes

* **pages:** move the epic submission form to the Epic tab ([#97](https://github.com/nanobpm/nano-workforce/issues/97)) ([da6db32](https://github.com/nanobpm/nano-workforce/commit/da6db32438d8b9fd9c04fea08ffe1f981728f314))


### Features

* **ops:** add GET /app/version endpoint for runtime identity ([#98](https://github.com/nanobpm/nano-workforce/issues/98)) ([538cf61](https://github.com/nanobpm/nano-workforce/commit/538cf615cf0f9b34cdb6417346e045fc6131423e))
* **pages:** link status column to the process explorer ([#99](https://github.com/nanobpm/nano-workforce/issues/99)) ([7f19a29](https://github.com/nanobpm/nano-workforce/commit/7f19a298b4c8c427c593a9d71181192bcac4a896))

## [0.32.2](https://github.com/nanobpm/nano-workforce/compare/v0.32.1...v0.32.2) (2026-08-09)


### Bug Fixes

* heal missing pull_requests FK parent before child writes ([#93](https://github.com/nanobpm/nano-workforce/issues/93)) ([896c1f7](https://github.com/nanobpm/nano-workforce/commit/896c1f7a71098463c581816ffc2821af196f779e)), closes [owner/repo#N](https://github.com/owner/repo/issues/N)

## [0.32.1](https://github.com/nanobpm/nano-workforce/compare/v0.32.0...v0.32.1) (2026-08-09)


### Bug Fixes

* **cancel:** reconcile terminated Epic/plan runs via instanceTracking ([#96](https://github.com/nanobpm/nano-workforce/issues/96)) ([3d0c5ba](https://github.com/nanobpm/nano-workforce/commit/3d0c5ba1b8bb9bd0c28432323b1867a7c86d1835))

# [0.32.0](https://github.com/nanobpm/nano-workforce/compare/v0.31.0...v0.32.0) (2026-08-09)


### Features

* **poller:** surface technical incidents on the PR row ([#95](https://github.com/nanobpm/nano-workforce/issues/95)) ([596153c](https://github.com/nanobpm/nano-workforce/commit/596153c0f58a0d511f4a7bac66896dab98a6a5c8)), closes [#94](https://github.com/nanobpm/nano-workforce/issues/94)

# [0.31.0](https://github.com/nanobpm/nano-workforce/compare/v0.30.0...v0.31.0) (2026-08-09)


### Bug Fixes

* **retro:** record a blocked retro when the retro process fails to start ([#92](https://github.com/nanobpm/nano-workforce/issues/92)) ([22bf171](https://github.com/nanobpm/nano-workforce/commit/22bf17114160bcd269b26fe635afdcc44c249dbe)), closes [#84](https://github.com/nanobpm/nano-workforce/issues/84)
* surface no-op plan-fanout epics as incidents instead of green ([#86](https://github.com/nanobpm/nano-workforce/issues/86)) ([#88](https://github.com/nanobpm/nano-workforce/issues/88)) ([8178aad](https://github.com/nanobpm/nano-workforce/commit/8178aad61fbf409990d331a4b08c786782d44cd1))


### Features

* **retro:** fold plan-review trace and task outcomes into the retro digest ([#91](https://github.com/nanobpm/nano-workforce/issues/91)) ([00d37e5](https://github.com/nanobpm/nano-workforce/commit/00d37e5a8c19238736d14b46401e7a3a41ee2083)), closes [#84](https://github.com/nanobpm/nano-workforce/issues/84) [#87](https://github.com/nanobpm/nano-workforce/issues/87) [#90](https://github.com/nanobpm/nano-workforce/issues/90)
* surface plan_reviews audit trace on epic and home pages ([#89](https://github.com/nanobpm/nano-workforce/issues/89)) ([2abaa25](https://github.com/nanobpm/nano-workforce/commit/2abaa253ac5bdd4d31a7bee1a0de412e5df56aae)), closes [#87](https://github.com/nanobpm/nano-workforce/issues/87) [#87](https://github.com/nanobpm/nano-workforce/issues/87) [#87](https://github.com/nanobpm/nano-workforce/issues/87) [#87](https://github.com/nanobpm/nano-workforce/issues/87) [#87](https://github.com/nanobpm/nano-workforce/issues/87)

# [0.30.0](https://github.com/nanobpm/nano-workforce/compare/v0.29.0...v0.30.0) (2026-08-09)


### Features

* **retro:** epic retrospective workflow that promotes shared learnings ([#84](https://github.com/nanobpm/nano-workforce/issues/84)) ([306e46f](https://github.com/nanobpm/nano-workforce/commit/306e46ff333bc5baff199713bf3a71f0c294e897)), closes [#82](https://github.com/nanobpm/nano-workforce/issues/82)

# [0.29.0](https://github.com/nanobpm/nano-workforce/compare/v0.28.0...v0.29.0) (2026-08-08)


### Features

* **app:** page nav bar + urban 0.28.0 multi-page navigation ([#83](https://github.com/nanobpm/nano-workforce/issues/83)) ([4011598](https://github.com/nanobpm/nano-workforce/commit/40115981211d4f50d6243ddf990c668e1a75c60c))

# [0.28.0](https://github.com/nanobpm/nano-workforce/compare/v0.27.0...v0.28.0) (2026-08-08)


### Features

* **blackboard:** first-class 'learning' kind for shared gotchas ([#82](https://github.com/nanobpm/nano-workforce/issues/82)) ([35ff09d](https://github.com/nanobpm/nano-workforce/commit/35ff09dce4a46dab03811fa5657828ca1f027c7c))

# [0.27.0](https://github.com/nanobpm/nano-workforce/compare/v0.26.0...v0.27.0) (2026-08-08)


### Features

* adopt @nanobpm/urban 0.27.0 for the themed console embed ([#81](https://github.com/nanobpm/nano-workforce/issues/81)) ([11ffecb](https://github.com/nanobpm/nano-workforce/commit/11ffecb3897a1ba5d57a9cda49f6859648c66f85)), closes [122/#123](https://github.com/nanobpm/nano-workforce/issues/123)

# [0.26.0](https://github.com/jwulf/urban-pr-review/compare/v0.25.0...v0.26.0) (2026-08-08)


### Features

* **cancel:** cooperative abandon check — a cancelled run makes no side effect ([#77](https://github.com/jwulf/urban-pr-review/issues/77)) ([11b0155](https://github.com/jwulf/urban-pr-review/commit/11b0155c0bd1ecadba7ac286317a2c5723a7d475)), closes [#76](https://github.com/jwulf/urban-pr-review/issues/76)

# [0.25.0](https://github.com/jwulf/urban-pr-review/compare/v0.24.0...v0.25.0) (2026-08-07)


### Features

* rebrand to "Nano Workforce" with a shipped app icon ([#71](https://github.com/jwulf/urban-pr-review/issues/71)) ([3fb5386](https://github.com/jwulf/urban-pr-review/commit/3fb53863def6e7525401ddb0280a15ab9c81aae6)), closes [#638](https://github.com/jwulf/urban-pr-review/issues/638)

# [0.24.0](https://github.com/jwulf/urban-pr-review/compare/v0.23.0...v0.24.0) (2026-08-07)


### Features

* **console:** epic pane — wave state × conflict graph (D10) ([#75](https://github.com/jwulf/urban-pr-review/issues/75)) ([54c9b5b](https://github.com/jwulf/urban-pr-review/commit/54c9b5bfb84ebcce435646191a27f07e78d28b45))

# [0.23.0](https://github.com/jwulf/urban-pr-review/compare/v0.22.0...v0.23.0) (2026-08-07)


### Features

* **merge:** trial-merge integration gate for semantic conflicts (D3) ([#70](https://github.com/jwulf/urban-pr-review/issues/70)) ([22b6f99](https://github.com/jwulf/urban-pr-review/commit/22b6f994757c359f9258ce873a6b052f967c9e47))

# [0.22.0](https://github.com/jwulf/urban-pr-review/compare/v0.21.0...v0.22.0) (2026-08-07)


### Features

* **merge:** serialize same-lane landings (D6) ([#68](https://github.com/jwulf/urban-pr-review/issues/68)) ([581d402](https://github.com/jwulf/urban-pr-review/commit/581d402c40ee43102a86a09d3e8c085eceb8c199)), closes [#67](https://github.com/jwulf/urban-pr-review/issues/67) [#49](https://github.com/jwulf/urban-pr-review/issues/49)

# [0.21.0](https://github.com/jwulf/urban-pr-review/compare/v0.20.0...v0.21.0) (2026-08-07)


### Features

* **coordination:** add waiting-for-lane task state (D7) ([#65](https://github.com/jwulf/urban-pr-review/issues/65)) ([2311b07](https://github.com/jwulf/urban-pr-review/commit/2311b07b1f93793cde801fad5bad7fcc793e52f2))

# [0.20.0](https://github.com/jwulf/urban-pr-review/compare/v0.19.0...v0.20.0) (2026-08-07)


### Features

* **merge:** reapply merge protocol on every landing attempt (D9) ([#66](https://github.com/jwulf/urban-pr-review/issues/66)) ([5bb4291](https://github.com/jwulf/urban-pr-review/commit/5bb42914589ad138afc5270b56af155b5ab2f4fb))

# [0.19.0](https://github.com/jwulf/urban-pr-review/compare/v0.18.0...v0.19.0) (2026-08-07)


### Features

* **merge:** guard against landing a PR into a dead-end base branch ([#60](https://github.com/jwulf/urban-pr-review/issues/60)) ([#61](https://github.com/jwulf/urban-pr-review/issues/61)) ([e108598](https://github.com/jwulf/urban-pr-review/commit/e108598b1f46b1a0d85c0a4689adb25be301ef2c)), closes [#54](https://github.com/jwulf/urban-pr-review/issues/54)

# [0.18.0](https://github.com/jwulf/urban-pr-review/compare/v0.17.0...v0.18.0) (2026-08-07)


### Features

* **coordination:** merge-exclusion graph + file-overlap conflict-scan (D1/D2) ([#59](https://github.com/jwulf/urban-pr-review/issues/59)) ([538ed94](https://github.com/jwulf/urban-pr-review/commit/538ed9448870abd99b5f2d82e14477a6bd299f97))

# [0.17.0](https://github.com/jwulf/urban-pr-review/compare/v0.16.0...v0.17.0) (2026-08-07)


### Features

* **coordination:** structured scope/impl-change report from implementers ([#55](https://github.com/jwulf/urban-pr-review/issues/55)) ([#56](https://github.com/jwulf/urban-pr-review/issues/56)) ([13b62c2](https://github.com/jwulf/urban-pr-review/commit/13b62c25052e2132ad677fec337dc7b2ca6997d3)), closes [#49](https://github.com/jwulf/urban-pr-review/issues/49) [nano-bpm#614](https://github.com/nano-bpm/issues/614) [#624](https://github.com/jwulf/urban-pr-review/issues/624) [#54](https://github.com/jwulf/urban-pr-review/issues/54)

# [0.16.0](https://github.com/jwulf/urban-pr-review/compare/v0.15.0...v0.16.0) (2026-08-07)


### Features

* **coordination:** epic blackboard — Tier 2 midflight coordination ([#54](https://github.com/jwulf/urban-pr-review/issues/54)) ([c873b63](https://github.com/jwulf/urban-pr-review/commit/c873b6309721d0e66d5be5c87d2a6df9896bf391)), closes [#52](https://github.com/jwulf/urban-pr-review/issues/52) [51/#53](https://github.com/jwulf/urban-pr-review/issues/53) [#42](https://github.com/jwulf/urban-pr-review/issues/42) [#53](https://github.com/jwulf/urban-pr-review/issues/53)

# [0.15.0](https://github.com/jwulf/urban-pr-review/compare/v0.14.3...v0.15.0) (2026-08-07)


### Features

* **coordination:** epic blackboard — Tier 1 dispatch/resume channel ([#53](https://github.com/jwulf/urban-pr-review/issues/53)) ([2dcfb8a](https://github.com/jwulf/urban-pr-review/commit/2dcfb8a5e1bd7beb89d174e646d40d610462365a)), closes [#51](https://github.com/jwulf/urban-pr-review/issues/51) [#49](https://github.com/jwulf/urban-pr-review/issues/49) [Magikcraft/nano-bpm#614](https://github.com/Magikcraft/nano-bpm/issues/614) [#52](https://github.com/jwulf/urban-pr-review/issues/52)

## [0.14.3](https://github.com/jwulf/urban-pr-review/compare/v0.14.2...v0.14.3) (2026-08-07)


### Bug Fixes

* **merge-loop:** add senior:rebase remediation arm ([#42](https://github.com/jwulf/urban-pr-review/issues/42)) ([#50](https://github.com/jwulf/urban-pr-review/issues/50)) ([a8195a4](https://github.com/jwulf/urban-pr-review/commit/a8195a49dae77868e1eb31a17aa32e2dfc3bc0a1))

## [0.14.2](https://github.com/jwulf/urban-pr-review/compare/v0.14.1...v0.14.2) (2026-08-06)


### Bug Fixes

* **review-round:** idempotent, non-destructive review re-request (unwedges [#35](https://github.com/jwulf/urban-pr-review/issues/35) class) ([#47](https://github.com/jwulf/urban-pr-review/issues/47)) ([7b9a391](https://github.com/jwulf/urban-pr-review/commit/7b9a391119be748344852ebb562cee39be6da8c9)), closes [#48](https://github.com/jwulf/urban-pr-review/issues/48)

## [0.14.1](https://github.com/jwulf/urban-pr-review/compare/v0.14.0...v0.14.1) (2026-08-06)


### Bug Fixes

* **plan-fanout:** keep template tokens out of XML comments ([#40](https://github.com/jwulf/urban-pr-review/issues/40)) ([46cad5a](https://github.com/jwulf/urban-pr-review/commit/46cad5a97dfb2fec0efbadf1514fe3cc75121775))
* **review:** give agents the exact Copilot review-request command ([#45](https://github.com/jwulf/urban-pr-review/issues/45)) ([2fda65c](https://github.com/jwulf/urban-pr-review/commit/2fda65c7bf924d8273c1104453f5b5512afb4e05)), closes [Magikcraft/nano-bpm#610](https://github.com/Magikcraft/nano-bpm/issues/610)

# [0.14.0](https://github.com/jwulf/urban-pr-review/compare/v0.13.0...v0.14.0) (2026-08-06)


### Features

* **merge:** execute a per-repo merge protocol (fresh head run + [@mergifyio](https://github.com/mergifyio) queue) ([#44](https://github.com/jwulf/urban-pr-review/issues/44)) ([712a0eb](https://github.com/jwulf/urban-pr-review/commit/712a0eb212616152a13a23b2306bebc19349746d)), closes [#43](https://github.com/jwulf/urban-pr-review/issues/43)

# [0.13.0](https://github.com/jwulf/urban-pr-review/compare/v0.12.4...v0.13.0) (2026-08-06)


### Features

* **pages:** make the pull-request list collapsible, remembered across sessions ([#41](https://github.com/jwulf/urban-pr-review/issues/41)) ([62e9249](https://github.com/jwulf/urban-pr-review/commit/62e924949b109f14657d103f1b69c9535ce3f205))

## [0.12.4](https://github.com/jwulf/urban-pr-review/compare/v0.12.3...v0.12.4) (2026-08-06)


### Bug Fixes

* **escalation:** make no-result rounds recoverable from the UI ([#38](https://github.com/jwulf/urban-pr-review/issues/38)) ([b7259a0](https://github.com/jwulf/urban-pr-review/commit/b7259a042fddfeee4f6bce90461e171afda5dc9f)), closes [597/#599](https://github.com/jwulf/urban-pr-review/issues/599)

## [0.12.3](https://github.com/jwulf/urban-pr-review/compare/v0.12.2...v0.12.3) (2026-08-06)


### Bug Fixes

* **prompts:** deliver agent base prompts as a variable bridge (unblock review resubmit) ([#37](https://github.com/jwulf/urban-pr-review/issues/37)) ([6ae1c05](https://github.com/jwulf/urban-pr-review/commit/6ae1c057c947b4251d5f390fb3beed4ffa61125f)), closes [#36](https://github.com/jwulf/urban-pr-review/issues/36) [#31](https://github.com/jwulf/urban-pr-review/issues/31) [597/#599](https://github.com/jwulf/urban-pr-review/issues/599) [#36](https://github.com/jwulf/urban-pr-review/issues/36)

## [0.12.2](https://github.com/jwulf/urban-pr-review/compare/v0.12.1...v0.12.2) (2026-08-06)


### Bug Fixes

* adopt urban 0.22 for {{template}} substitution + guard prompt-less agents ([#35](https://github.com/jwulf/urban-pr-review/issues/35)) ([6ad92c1](https://github.com/jwulf/urban-pr-review/commit/6ad92c1d1c73c87e43efc49958a5b9a41debfb13)), closes [#34](https://github.com/jwulf/urban-pr-review/issues/34) [#597](https://github.com/jwulf/urban-pr-review/issues/597) [#599](https://github.com/jwulf/urban-pr-review/issues/599) [#31](https://github.com/jwulf/urban-pr-review/issues/31) [#106](https://github.com/jwulf/urban-pr-review/issues/106) [jwulf/urban-pr-review#34](https://github.com/jwulf/urban-pr-review/issues/34)

## [0.12.1](https://github.com/jwulf/urban-pr-review/compare/v0.12.0...v0.12.1) (2026-08-05)


### Bug Fixes

* adopt @nanobpm/urban 0.21.0 (grid row-detail collapse) + add Renovate ([#33](https://github.com/jwulf/urban-pr-review/issues/33)) ([7d75b46](https://github.com/jwulf/urban-pr-review/commit/7d75b46c443e75477aab78ee576ef94c02d182ce))

# [0.12.0](https://github.com/jwulf/urban-pr-review/compare/v0.11.0...v0.12.0) (2026-08-05)


### Features

* harden review-wait against permanent stalls ([#32](https://github.com/jwulf/urban-pr-review/issues/32)) ([8303357](https://github.com/jwulf/urban-pr-review/commit/83033579a382e7d235dc8f248c821150a29ea121))

# [0.11.0](https://github.com/jwulf/urban-pr-review/compare/v0.10.0...v0.11.0) (2026-08-05)


### Features

* model-authored template-header prompts + senior:fix-ci auto-fix loop ([#31](https://github.com/jwulf/urban-pr-review/issues/31)) ([761213a](https://github.com/jwulf/urban-pr-review/commit/761213ae65a26e29594bca8ad0e78a48c435d8c0)), closes [nano-ide#106](https://github.com/nano-ide/issues/106) [jwulf/urban-pr-review#29](https://github.com/jwulf/urban-pr-review/issues/29)

# [0.10.0](https://github.com/jwulf/urban-pr-review/compare/v0.9.0...v0.10.0) (2026-08-05)


### Features

* gate a wave's implementation on the prior wave merging ([#30](https://github.com/jwulf/urban-pr-review/issues/30)) ([6f07fc4](https://github.com/jwulf/urban-pr-review/commit/6f07fc4771fc797ea5d61cd1c17aafce9f1c2dda))

# [0.9.0](https://github.com/jwulf/urban-pr-review/compare/v0.8.0...v0.9.0) (2026-08-05)


### Features

* configurable review-round cap (default 20) + submit-form field ([#27](https://github.com/jwulf/urban-pr-review/issues/27)) ([ee8e314](https://github.com/jwulf/urban-pr-review/commit/ee8e3140b15b02cf0a8a1f268187f539debfe211))

# [0.8.0](https://github.com/jwulf/urban-pr-review/compare/v0.7.0...v0.8.0) (2026-08-05)


### Features

* adversarial plan-review gate before fan-out dispatch ([#26](https://github.com/jwulf/urban-pr-review/issues/26)) ([1634c80](https://github.com/jwulf/urban-pr-review/commit/1634c80dfe0953f9a6739b8690ad0c5b7a990c74))

# [0.7.0](https://github.com/jwulf/urban-pr-review/compare/v0.6.0...v0.7.0) (2026-08-04)


### Features

* mixed sequential + parallel plan fan-out via dependency waves ([#21](https://github.com/jwulf/urban-pr-review/issues/21)) ([ee67032](https://github.com/jwulf/urban-pr-review/commit/ee6703235e081a8c20f2e8b7d76ebc2282450f51)), closes [#20](https://github.com/jwulf/urban-pr-review/issues/20) [#20](https://github.com/jwulf/urban-pr-review/issues/20)

# [0.6.0](https://github.com/jwulf/urban-pr-review/compare/v0.5.0...v0.6.0) (2026-08-04)


### Features

* make PR list entries clickable new-tab links ([#19](https://github.com/jwulf/urban-pr-review/issues/19)) ([cd73a02](https://github.com/jwulf/urban-pr-review/commit/cd73a0276f33ccafdd6e2f28d0d55bd40abc6b90))

# [0.5.0](https://github.com/jwulf/urban-pr-review/compare/v0.4.0...v0.5.0) (2026-08-04)


### Features

* plan-fanout — decompose an issue into a fleet of PRs ([#14](https://github.com/jwulf/urban-pr-review/issues/14)) ([#17](https://github.com/jwulf/urban-pr-review/issues/17)) ([462a8d7](https://github.com/jwulf/urban-pr-review/commit/462a8d7fd1360db8a1f5f7ae65dd2ff86dfc8b5a))

# [0.4.0](https://github.com/jwulf/urban-pr-review/compare/v0.3.1...v0.4.0) (2026-08-03)


### Features

* GET /app/status + cancel-by-prKey affordances ([#12](https://github.com/jwulf/urban-pr-review/issues/12)) ([9fbe066](https://github.com/jwulf/urban-pr-review/commit/9fbe066992b18529b485324b476ef031b4814565))

## [0.3.1](https://github.com/jwulf/urban-pr-review/compare/v0.3.0...v0.3.1) (2026-08-03)


### Bug Fixes

* **deps:** bump @nanobpm/urban to ^0.17.1 ([#11](https://github.com/jwulf/urban-pr-review/issues/11)) ([00d6a68](https://github.com/jwulf/urban-pr-review/commit/00d6a68e39d01369bd50784c846e97651a0022ac))

# [0.3.0](https://github.com/jwulf/urban-pr-review/compare/v0.2.1...v0.3.0) (2026-08-03)


### Features

* **poller:** read GitHub reviews via the host `gh` CLI ([#10](https://github.com/jwulf/urban-pr-review/issues/10)) ([d04c12e](https://github.com/jwulf/urban-pr-review/commit/d04c12e9de30276d2d6cae2405330146f2e9540f))

## [0.2.1](https://github.com/jwulf/urban-pr-review/compare/v0.2.0...v0.2.1) (2026-07-31)


### Bug Fixes

* add license, repository metadata, and marketplace manifest ([3382cfb](https://github.com/jwulf/urban-pr-review/commit/3382cfb404d5a76d8eec2f7cb1abd36cb889ef14))
