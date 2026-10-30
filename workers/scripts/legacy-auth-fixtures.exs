{:ok, _} = Application.ensure_all_started(:plug_crypto)
secret = String.duplicate("fixture-only-legacy-secret-", 3)
owner = "12345678-1234-4234-8234-123456789abc"
signed_at = System.argv() |> List.first("1700000000") |> String.to_integer()
options = Plug.Session.COOKIE.init(signing_salt: "DkrNptIj", secret_key_base: secret)

cookie =
  Plug.Session.COOKIE.put(
    %Plug.Conn{secret_key_base: secret},
    nil,
    %{"user_id" => owner, "username" => "Legacy name", "_csrf_token" => "fixture"},
    options
  )

IO.puts(
  Jason.encode!(%{
    secret: secret,
    owner: owner,
    cookie: cookie,
    extension:
      Plug.Crypto.sign(secret, "extension", {"oldroom1", owner <> ":tab1"}, signed_at: signed_at),
    old_extension: Plug.Crypto.sign(secret, "extension", "oldroom1", signed_at: signed_at)
  })
)
