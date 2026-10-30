# Run with mix run --no-start workers/scripts/export-legacy.exs DATABASE OUTPUT.
Code.require_file("legacy_export.ex", __DIR__)

case System.argv() do
  [database, output] ->
    try do
      result = Byob.LegacyExport.write!(database, output)

      IO.puts(
        "Exported #{result.rooms} rooms and #{result.pool} pool rows; SHA256 #{result.sha256}"
      )
    rescue
      _ ->
        IO.puts(
          :stderr,
          "Export failed. Check the source schema, destination permissions, and whether the output already exists."
        )

        System.halt(1)
    end

  _ ->
    raise "usage: mix run --no-start workers/scripts/export-legacy.exs DATABASE OUTPUT"
end
