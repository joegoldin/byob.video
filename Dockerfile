# Build stage
FROM hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20250317-slim AS build

RUN apt-get update -y && apt-get install -y build-essential git curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -f /var/lib/apt/lists/*_*

WORKDIR /app

ENV MIX_ENV=prod

RUN mix local.hex --force && mix local.rebar --force

COPY mix.exs mix.lock ./
RUN mix deps.get --only prod
RUN mix deps.compile

COPY config config
COPY lib lib
COPY assets assets
COPY priv priv

RUN mix assets.deploy
RUN mix compile
RUN mix release

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update -y && \
    apt-get install -y libstdc++6 openssl libncurses5 locales ca-certificates && \
    apt-get clean && rm -f /var/lib/apt/lists/*_*

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8

WORKDIR /app

COPY --from=build /app/_build/prod/rel/byob ./

RUN mkdir -p /app/priv

ENV PHX_SERVER=true
ENV PORT=4000

EXPOSE 4000

VOLUME ["/app/priv"]

CMD ["bin/byob", "start"]
