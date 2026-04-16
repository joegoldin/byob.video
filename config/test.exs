import Config

# Don't run the background pool scraper under test.
config :byob, start_pool_scheduler: false

# Use a dedicated test DB file so test data (pool entries, rooms) can't
# leak into the dev DB. Also set at runtime via System.put_env so the
# Persistence module's default path resolution picks it up.
System.put_env("BYOB_DB_PATH", "priv/byob_test.db")

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :byob, ByobWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "mky7LOj+vEDz9TVnRrZx1QKBvR8Arb+cHTgTq+w8zTnC5m4dF47dz4BgW/7h2z+C",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Enable helpful, but potentially expensive runtime checks
config :phoenix_live_view,
  enable_expensive_runtime_checks: true

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true
