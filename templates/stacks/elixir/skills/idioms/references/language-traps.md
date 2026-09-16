# Language Traps Reference

Syntax and semantics that read fine but are invalid or silently wrong.
Source: Phoenix `usage-rules/elixir.md` (the phx.new canon) — these are the
mistakes generators see most.

## Lists Do Not Support Access Syntax

Lists have no `Access` behaviour. Index access via brackets is invalid.

```elixir
# INVALID
i = 0
mylist = ["blue", "green"]
mylist[i]

# VALID — Enum.at, pattern matching, or the List module
Enum.at(mylist, i)
[first | _rest] = mylist
List.first(mylist)
```

## Never Rebind Inside a Block Expression

Variables are immutable but rebindable. `if`, `case`, `cond` and friends return
a value — bind *that*. A rebind inside the block is discarded.

```elixir
# INVALID — the assign is thrown away, socket is unchanged
if connected?(socket) do
  socket = assign(socket, :val, val)
end

# VALID — bind the result of the expression
socket =
  if connected?(socket) do
    assign(socket, :val, val)
  else
    socket
  end
```

Same trap in `case`, `cond`, `for`, `with`, and `try`.

## No `else if` / `elsif`

Elixir has `if/else`. It has no `else if` chain.

```elixir
# INVALID
if a do
  x
else if b do
  y
end

# VALID — cond for boolean chains
cond do
  a -> x
  b -> y
  true -> z
end

# VALID — case when you are matching a value
case thing do
  %{status: :active} -> x
  %{status: :draft} -> y
  _ -> z
end
```

In HEEx the same rule applies — see `elixir-liveview-patterns`
`references/heex-syntax.md`.

## One Module Per File

Never nest multiple modules in the same file. It causes cyclic dependencies
and compilation errors.

## Structs Have No Access Behaviour

`struct[:field]` is invalid — structs do not implement `Access` by default.

```elixir
# INVALID
changeset[:field]
user[:email]      # on a %User{} struct

# VALID — direct field access, or the struct's own API
user.email
Ecto.Changeset.get_field(changeset, :field)
```

Maps and keyword lists *do* implement `Access`, which is why this trap is easy
to hit. See `anti-patterns.md` "Assertiveness" for when `[:key]` on a map is
still the wrong call.

## Predicate Naming

- Functions returning a boolean end in `?`: `active?/1`, `empty?/1`.
- **Never** prefix with `is_` — that form is reserved for guards
  (`defguard is_thing/1`), which may be used in guard contexts.

## Date and Time: Use the Standard Library

`Time`, `Date`, `DateTime` and `Calendar` cover date/time manipulation. Read
their docs rather than reaching for a dependency. **Never** add a date/time
library unless asked; the one sanctioned exception is `date_time_parser` for
parsing arbitrary input strings.
