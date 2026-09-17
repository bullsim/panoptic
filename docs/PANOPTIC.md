# PANOPTIC Architecture

This document describes the durable architecture of PANOPTIC and the reasoning
behind it. It is not a changelog and not a status report; where it records
progress it does so only to distinguish what exists from what is planned.

It is written for someone joining the project, maintaining it later, reviewing an
architectural decision, or deciding where a new capability belongs.

---

## 1. What PANOPTIC is

PANOPTIC began as a fork of **God's Eye View**, an open-source photorealistic
3D globe that renders live aircraft, vessels, satellites, earthquakes, fires,
traffic and public cameras in a browser. That globe still works, and it remains
genuinely valuable: it is a well-built real-time visualisation of public data.

PANOPTIC extends it in a different direction. Rather than adding further map
layers, it adds a **backend evidence and temporal architecture** beneath the
existing one, so the system can answer questions a live map cannot:

- What was true at a particular moment in the past?
- What did the system *know* at that moment, as opposed to what we know now?
- What changed, and when did we learn it changed?
- Which source said what, and has any source since revised it?

A live map shows the present. PANOPTIC aims to retain evidence over time so the
past remains inspectable and the difference between *the world changing* and
*our knowledge changing* stays visible.

### Relationship to God's Eye View

PANOPTIC is a fork, not a rewrite. The divergence point is upstream commit
`6d83bb6`; everything after it is PANOPTIC work. The browser application,
rendering and existing data layers are inherited largely unchanged.

Two deliberate constraints keep the fork maintainable:

- **Upstream files are changed as little as possible.** Backend responsibilities
  are being extracted out of the very large `vite.config.js` into `server/`
  one collector at a time, so the fork's delta against upstream stays small.
- **Upstream documentation is left alone.** `README.md`, `DATA_SOURCES.md`,
  `docs/CURRENT-STATE.md` and the other root documents remain upstream's. This
  file is fork-owned precisely so it can never conflict with an upstream merge.

Data-source licensing and attribution are documented upstream in
[`DATA_SOURCES.md`](../DATA_SOURCES.md) and are unchanged by PANOPTIC.

---

## 2. Architectural principles

These are the durable rules. Each one already exists in committed code and is
enforced by tests.

| Principle | What it means in practice |
|---|---|
| **Source evidence first** | The system records what a source reported, before any interpretation. |
| **Observation v1 is canonical** | One internal evidence format for every domain. |
| **Evidence is immutable** | Nothing is updated or deleted; a correction is a new observation. |
| **Storage never creates identity** | An observation arrives with its id already minted; a store that invented one would be a second implementation of identity. |
| **Event Time ≠ Knowledge Time** | When something happened, and when PANOPTIC learned of it, are separate axes. |
| **Revisions do not overwrite history** | A revised earthquake magnitude sits alongside the original, not on top of it. |
| **Candidate keys are not resolved identity** | Shared identifiers are evidence of a possible match, never a claim that two records describe the same object. |
| **State and occurrence differ** | Some evidence describes a subject's condition; some records that something happened. They answer different questions. |
| **Element sets are evidence; positions are projections** | Orbital elements are stored; propagated satellite positions are computed, never persisted as evidence. |
| **PostgreSQL implements PANOPTIC semantics** | When SQL makes something inconvenient, the adapter adapts. The semantics do not bend to suit storage. |
| **The conformance suite is the specification** | Behaviour is defined by an executable, adapter-neutral test suite, not by prose. |
| **Browser payloads are not the canonical model** | What the globe receives is a rendering concern; Observation v1 is internal and server-side. |

One further principle is an **architectural direction, not yet an implemented
capability**: live visualisation should remain fully usable when persistence is
unavailable. Today this holds trivially, because no collector writes to the
Evidence Store at all. Making it hold once persistence is wired — so that a
database outage degrades history without touching the live globe — is a
requirement for the persistence slice, not something already built.

---

## 3. High-level layers

```
            Public / open sources
   aircraft · vessels · satellites · earthquakes · fires
                          │
                          ▼
                     COLLECTORS                        IMPLEMENTED
        fetch, cache, serve over HTTP  (celestrak, firms)
                          │
                          ▼
                   NORMALISATION                       IMPLEMENTED
        source format  ──▶  canonical evidence
                          │
                          ▼
                   OBSERVATION v1                      IMPLEMENTED
        immutable envelope · deterministic identity
                          │
                          ▼
                  EVIDENCE STORE                       IMPLEMENTED
     event time · knowledge time · revisions · lineage
                    │             │
                    ▼             ▼
              in-memory        PostgreSQL
              reference         durable adapter
                    │             │
                    └──────┬──────┘
                           ▼
                  SHARED QUERY SEMANTICS               IMPLEMENTED
            one implementation of the rules
                           │
                           ▼
              PERSISTENCE INTEGRATION                  NOT YET WIRED
        collectors writing evidence as it arrives
                           │
                           ▼
         HISTORICAL REPLAY / CORRELATION / ANALYSIS    PLANNED
                           │
                           ▼
        PRESENTATION · Cesium globe · future analysis  GLOBE EXISTS
```

The upper half of this diagram is built and tested. Everything from
**persistence integration** downwards is not: collectors currently serve live
data over HTTP and nothing writes to the Evidence Store. The globe exists, but it
reads live collector responses, not stored evidence.

---

## 4. Observation v1

An **Observation** is something a source reported, or PANOPTIC derived, about the
world at a particular time. It is raw evidence. It carries no significance
score, no anomaly flag, no analytical conclusion and no resolved entity id —
those belong to subsystems that do not exist yet, and placeholders for them would
invite fiction.

The envelope is deliberately small. A field earns a place in it only when several
domains use it with the *same* meaning; everything else lives in the per-domain
`properties` bag. That rule is what stops it becoming a hundred-nullable-field
universal object.

| Element | Purpose |
|---|---|
| `observationId` | Identity derived deterministically from canonical semantic inputs (section 5). |
| `observationType` | Registry key selecting the type's rules. |
| `observedAt` | **Event Time** — when the source says this was true. |
| `sourceRecordId` | The source's own identifier for the record, when it issues one. Optional. |
| `entityRef.keys` | Candidate entity keys — identifiers, not conclusions. |
| `geometry` | GeoJSON Point, governed by a per-type policy. |
| `vertical` | Altitude or depth with an explicit datum, kept out of `geometry`. |
| `properties` | Per-domain payload. |
| `derivation` | Ordered chain recording how the value came to be. |
| `classification` | Source-scheme classification, where a source provides one. |

Observations are delivered in a **batch**, which hoists what is constant across
its records: the `source` (`id` and optional `feed`), the `observationType`, the
**Knowledge Time** (`ingestedAt`), and a `derivation` prefix. The prefix is
composed onto each record — a record may extend the chain but never rewrite it,
because doing so would discard where the evidence came from.

`derivation` steps use a fixed method vocabulary: `direct_observation`,
`source_reported`, `ingested`, `calculated`, `interpolated`, `extrapolated`,
`reconstructed`, `simulated`, `manual`, `ai_derived`. `direct_observation` exists
for completeness but is expected to stay unused — PANOPTIC operates no sensors,
and saying so honestly is worth more than a flattering default.

### Observation is not Entity, and not Assessment

Three different things are kept apart on purpose:

- **Observation** — what a source said. Immutable, attributable, replayable.
- **Entity** — a real-world object that several observations may describe.
  PANOPTIC has *no* entity resolution; it has candidate keys (section 8).
- **Assessment** — an interpretation: significance, anomaly, intent, explanation.
  None of this exists yet, and none of it may be written into an Observation.

Collapsing these would make it impossible to distinguish evidence from
conclusion, which is the failure this architecture exists to prevent.

### Registered types

| Type | Temporal semantics | Geometry |
|---|---|---|
| `air.position` | state | required |
| `sea.position` | state | required |
| `ground.seismic_solution` | state | required |
| `space.orbital_elements` | state | **prohibited** |
| `environment.fire_detection` | occurrence | required |

Geometry policy has three states — required, optional, prohibited — rather than a
boolean. The prohibited case matters: an orbital element set describes an orbit,
not a place, and emitting `[0, 0]` for one would put Null Island into every
future spatial query.

---

## 5. Observation identity

Identical input yields an identical id, forever. That is what makes ingestion
idempotent, replay safe and duplicate delivery a no-op, while a materially
revised source record yields a *different* id.

The v1 identity contract:

- **SHA-256** over a canonical string
- the **first 128 bits** of the digest retained
- encoded in **lowercase, unpadded RFC 4648 base32**
- prefixed **`obs_`**

Two properties the canonical string is built to guarantee:

1. **Only declared inputs are hashed, never the whole document.** The canonical
   string is built from two parts:

   - **A fixed identity envelope** — the source id and feed, the observation
     type, the record's identity (its `sourceRecordId`, or the content-key
     material the type declares when the source issues no identifier of its
     own), and the Event Time.
   - **An explicit, ordered set of revision fields declared per observation
     type** — the values whose change constitutes a new version of the same
     record, each with a fixed decimal precision where it is numeric.

   Everything else an Observation carries takes no part in identity: arbitrary
   `properties`, and any incidental metadata a source adds later. Hashing a whole
   payload would make every id hostage to property insertion order, float
   formatting and fields nobody chose.
2. **The encoding is injective.** Fields are length-prefixed, so no two distinct
   field sequences can collide — a plain separator could not promise that.

Three identities are kept distinct:

| Concept | Question it answers |
|---|---|
| `sourceRecordId` | *Which thing* is the source describing? Stable across revisions. |
| `observationId` | *Which version* of that description is this? |
| Lineage | Which versions belong to the same record, so supersession can be computed? |

**Changing any of the following is a contract break requiring a new version, not
an edit:** the hash algorithm, the retained digest length, the base32 alphabet or
padding, the canonical field encoding or its length-prefix scheme, the
separators, the numeric precision rules, or the membership and order of any
type's identity fields. Every previously derived id would be silently orphaned,
and deduplication and replay would both break without raising an error. Golden
vectors in the contract tests pin the canonical strings *and* the resulting ids
byte-for-byte so this cannot happen quietly.

---

## 6. Event Time and Knowledge Time

This is the distinction the rest of the architecture rests on.

| Axis | Field | Meaning |
|---|---|---|
| **Event Time** | `Observation.observedAt` | When the source says the evidence was true, or when the thing occurred. |
| **Knowledge Time** | `ObservationBatch.ingestedAt` | When PANOPTIC **first** possessed that evidence. |

Knowledge Time is supplied semantic data. It is not a database commit time, not
`Date.now()` at insert, and no adapter may substitute one. It is written once and
never updated: re-delivery of the same observation does not make it newly known.

### Worked example: a revised earthquake

```
14:00   an earthquake occurs                        (Event Time)
14:01   PANOPTIC receives a solution: M4.2          (Knowledge Time)
14:07   the source revises it: M4.4                 (Knowledge Time)
```

Both solutions describe the **same event at the same instant**. They are two
revisions of one assertion, not two earthquakes. Two different questions can now
be asked, and they have different correct answers:

| Question | Answer |
|---|---|
| "What do we currently believe happened at 14:00?" | **M4.4** |
| "What did PANOPTIC know at 14:03?" | **M4.2** |

The second question is unanswerable in any system that overwrites. It is what
makes an audit, an after-action review or a replay honest rather than
retrospectively tidied.

### Worked example: late-arriving aircraft evidence

```
position A  observed 14:20   known 14:20
position B  observed 14:25   known 14:25
position C  observed 14:30   known 14:40      <- arrived late
```

Asked *"where was the aircraft at 14:32, as known at 14:35?"*, the answer is **B**.
C describes an earlier moment than 14:32 and is the better answer today — but at
14:35 it had not arrived, so claiming it would be inventing knowledge the system
did not have.

Note what this requires of the implementation: the Knowledge Time filter must be
applied **before** selecting which state is in force. Selecting the state first
and filtering afterwards would drop C and return *nothing* for that aircraft,
rather than falling back to B.

---

## 7. State and occurrence

Every registered type declares `temporalSemantics`:

- **`state`** — the observation asserts the condition of an identified record at
  an instant, so "what was in force at time T?" is meaningful. Currently:
  `air.position`, `sea.position`, `ground.seismic_solution`,
  `space.orbital_elements`.
- **`occurrence`** — the observation asserts only that something happened at a
  place and time, with no persistent subject. Currently:
  `environment.fire_detection`.

`statesAt()` therefore **rejects** occurrence types rather than returning an empty
list. A fire detection has no subject whose state could be in force; answering
`[]` would read as "nothing was burning", which is a different and false claim
from "that question does not apply here". The honest query for occurrences is
`observationsBetween()` over a window.

`temporalSemantics` is metadata about the *type*. It never participates in
identity, so adding it to a type cannot change any previously derived id.

### Time windows are `[from, to)`

Start inclusive, end exclusive — permanently. Adjacent windows therefore tile
without counting a boundary observation twice, which is what makes paging through
history by hour or by day safe. `from === to` is a valid empty interval;
`from > to` is a malformed query and is rejected rather than silently answered.

---

## 8. Record keys, state keys and candidate entity keys

Three different concepts, answering three different questions.

| Key | Composed of | Answers |
|---|---|---|
| **Record key** | `source.id`, `source.feed`, `observationType`, `sourceRecordId` | "All evidence one source holds about one record." |
| **State key** | record key **+** `observedAt` | "All versions of one assertion about one instant." |
| **Candidate entity keys** | recognised `namespace=value` pairs | "What else might describe this object, across sources?" |

The placement of `observedAt` is what separates successive states from revisions
of one state. For an aircraft, one record key holds thousands of states with one
version each; for an earthquake, one record key holds one state with several
versions.

When a source issues no record identifier, both keys are **null**. Such evidence
is still stored and still retrievable by window — it simply has no lineage to
hold a state, because there is no subject for a state to be about. A record
identity is never manufactured from `entityRef.keys` to paper over this.

### Candidate keys are not identity

Recognised namespaces, each present because committed code already treats the
value as a craft's identifier:

| Namespace | Describes |
|---|---|
| `icao24` | aircraft |
| `mmsi` | vessel |
| `imo` | vessel |
| `noradId` | satellite |
| `intlDesignator` | satellite |

Values are canonicalised per namespace before comparison, so a zero-padded
catalogue number and an unpadded one are the same object, while a malformed value
matches nothing. Unrecognised property names are ignored rather than compared —
an incidental field must never become a way to join unrelated evidence.

**A candidate-key match is evidence of a shared identifier, nothing more.**
`icao24` addresses are reassigned in practice and `mmsi` is routinely spoofed.
Results are explicitly marked as candidate matches and carry the tokens they
matched on, so a caller cannot mistake the join for a resolved entity.
`entityHistory` is candidate-based cross-source history; it is **not** entity
resolution, and PANOPTIC has none.

---

## 9. Revisions

One state may have many revisions. Each is an immutable row; none replaces
another.

- The revision **in force** is the one with the greatest Knowledge Time, with a
  deterministic tie-break on `observationId` when two arrive in the same
  millisecond. The tie-break is arbitrary but stable across runs, hosts and
  storage adapters — which is the property that actually matters.
- **`revisionsOf`** is the audit primitive: it returns every visible version,
  oldest-known first, and never collapses.
- **`recordHistory`** and **`entityHistory`** resolve revisions per state, so a
  source changing its mind reads as one state whose value changed, not as two
  events or as an object being in two places.
- A **duplicate `observationId` is a no-op**. In particular it does not move
  Knowledge Time: the store records when PANOPTIC *first* possessed the evidence,
  so a re-poll, a retry or a replay is safe.

If two observations ever shared an id but differed materially, that would be an
integrity anomaly in whatever produced them — identity is derived from declared
identity and revision inputs, so materially different records should not collide
— and emphatically not a revision mechanism. A genuine revision changes an
identity-bearing field and therefore gets its own id.

---

## 10. Satellite evidence

PANOPTIC stores **orbital element sets** as observations. It does **not** persist
continuously propagated satellite positions.

The reasoning: a satellite position is not something a source reported. It is a
computation:

```
orbital element set  +  calculatedFor (a time)  +  SGP4  =  a projection
```

Persisting those projections would flood the evidence store with values no source
ever asserted, and make an SGP4 output indistinguishable from a real measurement.
The element set is the evidence; the position is derived on demand by whatever
needs it. **The Evidence Store performs no SGP4 propagation** and stores no
geometry for this type.

Choosing which element set to propagate from is its own operation, with an
explicit mode:

| Mode | Selects | Use |
|---|---|---|
| **`causal`** | only epochs at or before the Event Time | Causal and as-known questions: "from what could this have been computed at that time?" |
| **`reconstruction`** | the nearest epoch on *either* side | Best physical estimate. SGP4 accuracy decays in both directions from epoch, so the nearest set is usually better — and selecting a later epoch is explicitly hindsight. |

The mode changes **epoch selection and nothing else**. Candidate matching and
revision resolution happen first, identically in both modes: a question about
orbits is not a different theory of what supersedes what.

Both modes select from the same immutable stored element-set evidence. Neither
creates evidence, and neither is a judgement about which observations are
trustworthy — the difference is only which epochs are eligible. Knowledge Time
remains an independent filter in both: it governs what PANOPTIC held, while the
mode governs which epoch is chosen from what it held.

### Two different futures, never conflated

- **`usesFutureEpoch`** — the selected element set's epoch is later than the time
  asked about. A fact about the orbit, and about nothing else.
- **Knowledge availability** — whether PANOPTIC held that element set at all.
  This is expressed *only* by the Knowledge Time filter, never by a flag.

An element set with a 15:00 epoch ingested at 13:00 has a future epoch and was
already known. One with a 12:00 epoch ingested at 15:00 has no future epoch and
is simply absent from any query whose knowledge horizon precedes 15:00. Folding
these together would libel evidence the system genuinely had.

---

## 11. The Evidence Store

Three files carry the design:

| File | Role |
|---|---|
| `server/storage/semantics.js` | **The rules.** Pure, adapter-neutral: acceptance, batch preparation, key resolution, revision collapse, ordering, element-set selection, and one query-preparation entry point per operation. |
| `server/storage/memory.js` | **The reference implementation.** Indexes over the shared rules, written for clarity rather than speed. |
| `src/data/observationStoreConformance.mjs` | **The specification.** An adapter-neutral suite every implementation must pass. |

The split is deliberate: *one implementation of the rules, many places to put
rows*. A storage adapter is a different place to put rows, never a different set
of rules. Query preparation returns the values an adapter needs to execute — a
resolved record key, a state key, canonical candidate-key tokens — which makes
the rules hard to skip rather than merely available.

The conformance suite is the **living behavioural specification**. Prose rots;
an executable suite that both implementations must pass cannot.

### Operations

| Operation | Behaviour |
|---|---|
| `insertBatch` | Validates and prepares the whole batch, then applies it atomically. Idempotent per `observationId`. |
| `observationsBetween` | Every observation whose Event Time falls in `[from, to)`. No revision collapse — the raw evidence window. |
| `statesAt` | What was in force at an instant, one row per record. Rejects occurrence types. |
| `recordHistory` | The ordered states one source holds about one record, revisions resolved. |
| `revisionsOf` | Every version of one assertion about one instant, oldest-known first. The audit primitive. |
| `entityHistory` | Candidate-key matches across sources, revisions resolved, explicitly marked as candidate matches. |
| `elementSetFor` | Chooses the orbital element set to propagate from, by mode. |
| `get` | One stored observation by id, or null. |
| `size` | Count of distinct observations held. |

Every operation is awaitable. The in-memory store answers synchronously, which is
what a `Map` can do; a database adapter returns promises. Callers await either
way, so one suite tests both.

---

## 12. The PostgreSQL implementation

PostgreSQL is a **verified durable adapter**. It passes the identical conformance
suite as the reference store — unforked and unmodified.

Verification checkpoint:

- Verified against **PostgreSQL 18.6**
- **89** shared conformance tests passed
- **11** PostgreSQL-specific tests passed
- **100 / 100** total under the explicit integration command, with no skips

Physical design:

| Decision | Detail |
|---|---|
| One table | `observation`, with `observation_id` as primary key |
| Identity | stored as `text` (not binary): the tie-break compares ids as strings, and the base32 alphabet is not in ASCII order, so byte ordering would select a different revision |
| Times | `observed_at` and `ingested_at` as `timestamptz`, exact to the millisecond |
| Document | the full canonical Observation as `jsonb`, never rewritten by SQL |
| Candidate keys | canonical tokens in a `text[]` column, matched by exact overlap |
| Derived keys | `record_key` and `state_key` **precomputed in shared JavaScript**, never built in SQL |
| Append-only | database triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on evidence |
| Duplicates | `ON CONFLICT DO NOTHING` — never an upsert, so Knowledge Time cannot be rewritten |
| Not used | table partitioning, TimescaleDB, PostGIS semantics |

PostgreSQL does not independently redefine Evidence Store semantics. Shared
JavaScript remains authoritative for canonicalisation, key construction,
identity, revision resolution, ordering and the other shared semantic decisions.
SQL is responsible for what a database is genuinely for: durable storage,
transactions, constraints, indexing, and narrowing the candidate rows a query
must consider. Whatever the division of labour, the resulting behaviour must
satisfy the shared executable specification — that is what makes the split
verifiable rather than merely intended.

Where PostgreSQL made something inconvenient, the adapter adapted. The semantics
did not.

---

## 13. Why PostGIS is deferred

PANOPTIC is obviously a spatial system, and the eventual use of PostGIS is
expected. It is nonetheless deliberately absent today:

- no geometry column
- no GiST index
- no `CREATE EXTENSION postgis`

The reason is that **the Evidence Store contract currently has no spatial query
primitive**. None of its operations takes a bounding box, a radius or a polygon.
Adding a spatial column now would create the only piece of SQL in the system with
no reference semantics and no conformance coverage — inverting the discipline
that everything else follows.

PostGIS should arrive together with a defined spatial Evidence Store operation
and the conformance tests that pin its behaviour. The container image is already
the PostGIS family so the environment will not have to change when that happens.

This is a deferral, not an oversight.

---

## 14. Why there is only one table

The physical model is intentionally a single `observation` table. Several
additional tables were considered and deferred:

| Considered | Why deferred |
|---|---|
| `observation_batch` | The batch format carries no batch identifier, so a table would force storage to *invent* one — the same class of error as inventing an observation id. No current query uses batch membership. |
| `source` | A source is an id and an optional feed. There is nothing else to record about it yet. |
| Resolved entities | Entity resolution does not exist. A table would imply conclusions nothing is entitled to draw. |
| Raw evidence | Retaining original payloads is valuable but has no defined contract yet. |
| Source fetch history | Belongs with raw evidence, and shares its undefined semantics. |
| Aggregates | Premature before the query patterns are known. |

None of this is permanent. Raw evidence, source retrieval history, resolved
entities and aggregates are all plausible later additions — each should arrive
when its semantics are defined and testable, not before.

---

## 15. Current implementation status

**Implemented and tested**

| Capability |
|---|
| PANOPTIC standalone backend runtime and dev launcher |
| CelesTrak collector, migrated out of the Vite config |
| NASA FIRMS collector, migrated out of the Vite config |
| Server-side configuration and secret handling |
| Observation v1 contract, identity and validation |
| In-memory Evidence Store (reference implementation) |
| Shared adapter-neutral semantics and conformance suite |
| PostgreSQL adapter with verified conformance parity |

**Not yet implemented**

| Capability | Notes |
|---|---|
| Live collector persistence | Nothing writes evidence yet |
| Production database configuration | No `PANOPTIC_DATABASE_URL` exists |
| Persistence health reporting | Not in `/health` |
| Historical replay API | No query surface exposed to the browser |
| Spatial evidence queries | See section 13 |
| Entity resolution | Candidate keys only |
| Baselines and anomaly detection | — |
| Correlation and intelligence fusion | — |
| Natural-language analysis layer | — |
| TimescaleDB, raw evidence store | — |

---

## 16. Development and testing

**Normal development needs no database.**

```
npm run dev      # globe + PANOPTIC backend; no PostgreSQL, no containers
npm test         # full unit suite; PostgreSQL tests skip cleanly
npm run build
```

**PostgreSQL integration testing** is explicit and opt-in:

```
npm run db:up          # start a disposable PostgreSQL container
npm run test:postgres  # run the conformance suite against it
npm run db:down        # stop and remove it, data volume included
```

Properties of the test database:

- **Disposable.** Each store instance gets its own schema and drops it afterwards;
  the container keeps no persistent volume.
- **Loopback only.** It is published on `127.0.0.1` and is never reachable from
  the network.
- **Named for safety.** The harness refuses to run unless the database name ends
  in `_test`, because it creates and drops schemas.
- **Separately configured.** Integration tests read their own environment
  variable and never fall back to a production setting.

`npm test` stays green with no database and no container runtime installed. The
explicit integration command, by contrast, fails loudly rather than skipping — an
integration command that silently skips reports success for work it never did.

Local configuration lives in `.env`, which is git-ignored. No credential belongs
in this repository or in this document; see `.env.example` for the variable names
and their purpose.

---

## 17. Architectural roadmap

Conceptual order, without dates or commitments to unmade decisions.

| Stage | State |
|---|---|
| Observation v1 contract | Done |
| Evidence Store semantics | Done |
| PostgreSQL parity | Done |
| Architecture documentation | This document |
| Live persistence integration | Next |
| Spatial evidence queries | Later |
| Historical replay API | Later |
| Baselines and anomaly detection | Later |
| Correlation and intelligence fusion | Later |
| Natural-language analysis layer | Later |

For **Evidence Store and storage work**, the ordering that has kept the reference
and the database honest should continue: define the semantics in the shared
reference behaviour and the conformance suite before any storage adapter depends
on them.

Other subsystems need not follow that shape literally. An analysis, detection or
interface component should have its own explicit contract and its own tests,
appropriate to its domain — not an entry in `memory.js` or the Evidence Store
conformance suite. The durable rule is that a capability earns a defined,
testable contract before anything is built on top of it; the form that contract
takes belongs to the subsystem.

---

## 18. Authoritative files

| File | Authority on |
|---|---|
| `server/contracts/observation/v1.js` | The Observation contract, type registry and geometry policy |
| `server/contracts/observation/identity.js` | The identity algorithm and canonical encoding |
| `server/contracts/observation/validate.js` | Envelope validation (development and tests only) |
| `server/storage/contract.js` | Record and state keys, candidate-key namespaces, temporal semantics errors |
| `server/storage/semantics.js` | All shared Evidence Store rules |
| `server/storage/memory.js` | The reference implementation |
| `server/storage/postgres/store.js` | The PostgreSQL adapter |
| `server/storage/postgres/schema.js` | The physical schema and append-only enforcement |
| `src/data/observationContract.test.mjs` | Contract tests and golden identity vectors |
| `src/data/observationStoreConformance.mjs` | The adapter-neutral behavioural specification |
| `src/data/observationStorePostgres.test.mjs` | PostgreSQL binding and database-specific tests |

**If this document and the executable contract disagree, the contract and its
tests win.** Prose drifts; the conformance suite is what both implementations are
actually held to. Correct the prose.
