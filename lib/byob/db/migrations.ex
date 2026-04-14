defmodule Byob.DB.Migrations do
  @moduledoc """
  Schema migration runner for room state. When the room state shape changes
  between versions, migrations transform persisted state on load.
  """

  @current_version 1

  def current_version, do: @current_version

  @doc """
  Run all migrations from `from_version` up to `to_version`.
  Each step calls migrate_N_to_N+1/1.
  """
  def run(state, from_version, to_version) when from_version < to_version do
    Enum.reduce(from_version..(to_version - 1), state, fn version, acc ->
      apply(__MODULE__, :"migrate_#{version}_to_#{version + 1}", [acc])
    end)
  end

  def run(state, _from, _to), do: state

  # Identity migration — framework is ready for future changes
  def migrate_1_to_2(state), do: state
end
