# Build stage
FROM elixir:1.19 AS build

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

# Compile first so phoenix-colocated hooks are generated in _build
RUN mix compile
RUN mix assets.deploy
RUN mix release

# Runtime stage
FROM debian:trixie-slim

RUN apt-get update -y && \
    apt-get install -y libstdc++6 openssl libncurses6 locales ca-certificates && \
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
