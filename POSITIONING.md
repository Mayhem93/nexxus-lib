<!--
  DRAFT — not for the README yet.
  This text assumes the configurable data/worker pipeline is in place and working.
  Hold until that ships.
-->

# Why Nexxus?

Most backend-as-a-service platforms hand you a complete stack: their database, their
authentication, their hosting, their query language. That is often a trade worth making —
you get a working backend in an afternoon and someone else operates it.

Nexxus makes a different trade. It doesn't bring a database. It runs on the infrastructure
you already operate and gives you the application layer on top of it: realtime
subscriptions, permissions, multi-application hosting, and a processing pipeline you can
extend with your own code.

## This is not a Firebase replacement

Firebase is very good at what it does, and for a lot of projects it is simply the right
answer. It is built for developers who would rather not think about infrastructure at all,
and it is backed by a company that will keep it ahead on breadth, tooling and mobile
support for the foreseeable future.

Nexxus is not trying to win that comparison. It sits at the other end of the same axis:
it's for teams who already run infrastructure and want the realtime application layer
without also adopting someone else's database, query language and hosting model.

If Firebase fits your project, use Firebase. The rest of this page is for the cases where
it doesn't.

## What's actually different

**It doesn't own your data layer.**
Nearly every backend platform ships its own datastore, and that bundling is where lock-in
comes from — leaving usually means rewriting data access, permission rules, and sometimes
the data model itself. Nexxus reaches your storage through adapters, which makes the
database a deployment decision instead of a permanent one.

**Bring your own pieces.**
Database, message broker, cache, authentication strategy, configuration source — each one
is pluggable. The set that ships today is small, and intentionally so; the goal was never
to support every product on the market. The point is that the interfaces are open, so the
defaults are a starting position rather than a ceiling.

**The pipeline is yours to extend.**
Between the moment a write arrives and the moment connected clients hear about it, Nexxus
runs a pipeline of workers. You can insert your own anywhere along it. A worker that runs
an AI model over newly created objects, one that pushes to a search index, one that writes
an audit trail, one that calls an external service — the pipeline doesn't care what your
worker does, only that it accepts a message and passes one along.

This is the part that lets Nexxus compose with other tools instead of competing with them.
The interesting integrations aren't ones Nexxus has to ship; they're ones you write.

**One deployment, many applications.**
A single Nexxus deployment hosts many independent applications, each with its own schema,
users and permissions. If you run several small products, an internal platform, or client
work, you don't need a separate project — or a separate bill — for each one.

**Schemas are configuration, not migrations.**
Adding or changing a model type is a configuration change. There's no migration to write
and no redeploy to wait for.

**Permissions apply to realtime, not just requests.**
Access rules are evaluated on the server and enforced on live subscriptions as well as on
ordinary calls, so a client cannot subscribe to more than it is allowed to see. Permission
logic that has to live in your application is permission logic that can be bypassed.

**It runs where you need it to run.**
Your cloud, someone else's, your own datacenter, or entirely disconnected from the
internet. For teams with data-residency, sovereignty or air-gap requirements, that isn't a
preference — it's the whole question.

## Familiar on purpose

Nexxus has its own way of organising data, and there is a real learning curve to it. Where
it could, it borrowed shapes you already know rather than inventing new ones: permission
rules read like IAM policies, and filters read like database queries you have written
before. Less to memorise, fewer surprises.

## What it costs you

**It expects real infrastructure.** Nexxus assumes you are comfortable running and
operating services. There is no single-binary, one-command story today.

**The learning curve is genuine.** How applications, schemas, permissions and the pipeline
fit together is its own model, and you will spend time on it before it pays off.

**It is young, and it is small.** Fewer integrations, fewer tutorials and a much smaller
community than any of the established platforms. That is the honest state of it.

## When not to use Nexxus

- You want a working backend this afternoon. Firebase, Supabase or PocketBase will get you
  there faster, and that's a good reason to use them.
- You don't operate infrastructure and have no interest in starting.
- You need mature mobile SDKs and offline-first synchronisation today.
- You need vendor support and contractual guarantees now.

## Who it is for

- Teams already running their own database, broker and cache who want a realtime layer on
  top of that, rather than another platform beside it.
- Platform teams and agencies hosting many applications from one deployment.
- Deployments constrained by data residency, sovereignty or isolation requirements.
- Anyone who needs custom work in the write path — enrichment, moderation, indexing,
  inference — handled inside the pipeline instead of bolted on around it.

## Open source

Nexxus is open source because anything meant to run inside other people's infrastructure
should be readable by the people running it. You can host it, fork it, and write your own
adapters and workers without asking permission. It is not a commercial product with an
open-source edition, and there is no upsell path built into it.

## Worth a look?

If you already run the infrastructure, and what you're missing is the realtime application
layer on top of it — subscriptions, permissions, many applications, and somewhere sensible
to put your own processing — Nexxus is worth an evaluation.

If not, the other options in this space are good, and they're genuinely recommended above.
