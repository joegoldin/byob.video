defmodule ByobWeb.ExtensionChannelTest do
  use ExUnit.Case, async: false

  alias ByobWeb.{ExtensionSocket, ExtensionChannel}
  alias Byob.RoomServer

  setup do
    room_id = "exttest#{:erlang.unique_integer([:positive])}"
    {:ok, _pid} = Byob.RoomManager.ensure_room(room_id)

    {:ok, socket} =
      connect(ExtensionSocket, %{}, %{})

    {:ok, _reply, socket} =
      subscribe_and_join(socket, ExtensionChannel, "extension:#{room_id}", %{
        "username" => "ExtUser"
      })

    %{socket: socket, room_id: room_id}
  end

  defp connect(module, params, connect_info) do
    module.connect(
      params,
      %Phoenix.Socket{
        endpoint: ByobWeb.Endpoint,
        handler: module,
        transport: :websocket,
        serializer: Phoenix.Socket.V2.JSONSerializer,
        transport_pid: self()
      },
      connect_info
    )
  end

  defp subscribe_and_join(socket, channel, topic, payload) do
    socket = %{socket | topic: topic, channel: channel}

    case channel.join(topic, payload, socket) do
      {:ok, reply, socket} ->
        # Subscribe to the topic so we can receive broadcasts
        Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{extract_room_id(topic)}")
        {:ok, reply, socket}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp extract_room_id("extension:" <> room_id), do: room_id

  describe "join" do
    test "returns room state", %{socket: socket} do
      # Already joined in setup — verify socket has room state
      assert socket.assigns.room_id
    end
  end

  describe "handle_in" do
    test "video:play broadcasts sync_play", %{socket: socket, room_id: room_id} do
      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

      ExtensionChannel.handle_in("video:play", %{"position" => 10.0}, socket)

      assert_receive {:sync_play, %{time: 10.0}}
    end

    test "video:pause broadcasts sync_pause", %{socket: socket, room_id: room_id} do
      # Need a video in queue first
      pid = GenServer.whereis({:via, Registry, {Byob.RoomRegistry, room_id}})

      RoomServer.add_to_queue(
        pid,
        socket.assigns.user_id,
        "https://youtube.com/watch?v=test",
        :now
      )

      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

      ExtensionChannel.handle_in("video:pause", %{"position" => 5.0}, socket)

      assert_receive {:sync_pause, %{time: 5.0}}
    end

    test "video:seek broadcasts sync_seek", %{socket: socket, room_id: room_id} do
      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

      ExtensionChannel.handle_in("video:seek", %{"position" => 30.0}, socket)

      assert_receive {:sync_seek, %{time: 30.0}}
    end

    test "video:play and video:seek still broadcast separately", %{
      socket: socket,
      room_id: room_id
    } do
      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

      ExtensionChannel.handle_in("video:play", %{"position" => 10.0}, socket)
      ExtensionChannel.handle_in("video:seek", %{"position" => 30.0}, socket)

      assert_receive {:sync_play, %{time: 10.0}}
      assert_receive {:sync_seek, %{time: 30.0}}
    end

    test "sync:ping replies with pong", %{socket: socket} do
      {:reply, {:ok, reply}, _socket} =
        ExtensionChannel.handle_in("sync:ping", %{"t1" => 12345.0}, socket)

      assert reply.t1 == 12345.0
      assert is_integer(reply.t2)
      assert is_integer(reply.t3)
    end
  end
end
