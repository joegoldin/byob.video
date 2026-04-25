defmodule Byob.Build do
  @moduledoc """
  Build-time metadata baked into the release at compile time.

  `sha/0` returns the short commit hash that produced this build.
  Resolved (in order):

    1. `GIT_SHA` env var — set in production by the Dockerfile's build
       arg / `just deploy` recipe so Fly releases carry their git ref.
    2. `git rev-parse --short HEAD` if a `.git` directory is present
       (local dev).
    3. `nil` — release was built without git context (manual Docker
       run, etc.).

  All three branches evaluate at compile time; the runtime release
  carries a static string.
  """

  @sha (
          cond do
            (env_sha = System.get_env("GIT_SHA")) && env_sha != "" ->
              env_sha |> String.trim() |> String.slice(0, 7)

            File.exists?(Path.join(File.cwd!(), ".git")) ->
              case System.cmd("git", ["rev-parse", "--short", "HEAD"], stderr_to_stdout: true) do
                {sha, 0} -> String.trim(sha)
                _ -> nil
              end

            true ->
              nil
          end
        )

  @repo_url "https://github.com/joegoldin/byob.video"

  def sha, do: @sha

  def commit_url do
    case @sha do
      nil -> nil
      sha -> "#{@repo_url}/commit/#{sha}"
    end
  end
end
