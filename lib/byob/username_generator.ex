defmodule Byob.UsernameGenerator do
  @adjectives ~w(
    Swift Bold Brave Calm Cool Dark Deep Fast Fierce Free
    Grand Happy Keen Kind Light Lucky Mild Noble Quick Rare
    Sharp Shy Sly Smart Soft Still Tall True Vast Warm
    Wild Wise Bold Bright Clear Crisp Fair Fine Fresh Gentle
    Glad Great Lush Neat Pure Rich Safe Slim Strong Vivid
  )

  @animals ~w(
    Hawk Bear Wolf Lion Fox Deer Dove Eagle Falcon Heron
    Otter Panda Raven Tiger Whale Crane Drake Finch Gecko Hound
    Koala Lemur Moose Newt Owl Puma Quail Robin Shark Swan
    Trout Viper Wren Yak Bison Cedar Dingo Egret Ferret Grouse
    Ibis Jackal Kite Llama Marten Narwhal Osprey Parrot Quetzal Raptor
  )

  def generate do
    adjective = Enum.random(@adjectives)
    animal = Enum.random(@animals)
    number = :rand.uniform(99) |> Integer.to_string() |> String.pad_leading(2, "0")
    "#{adjective}#{animal}#{number}"
  end
end
