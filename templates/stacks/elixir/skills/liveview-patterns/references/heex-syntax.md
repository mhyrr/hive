# HEEx Syntax Reference

Template syntax that raises at compile time when you get it wrong.
Source: Phoenix `usage-rules/html.md` (the phx.new canon).

Templates are **always** `~H` or `.html.heex`. **Never** `~E`.

## Interpolation: `{...}` vs `<%= %>`

`<%= %>` works **only** inside tag bodies. Attributes take `{...}` only.

- Tag attributes → `{...}`
- Values in tag bodies → `{...}`
- Block constructs (`if`, `cond`, `case`, `for`) in tag bodies → `<%= ... %>`

```heex
<%!-- ALWAYS --%>
<div id={@id}>
  {@my_assign}
  <%= if @some_block_condition do %>
    {@another_assign}
  <% end %>
</div>

<%!-- NEVER — syntax error, the program terminates --%>
<div id="<%= @invalid_interpolation %>">
  {if @invalid_block_construct do}
  {end}
</div>
```

## Comments

HEEx comments are `<%!-- comment --%>`. Always use that form in templates.

## Class Lists

Class attributes support lists, but you **must** use `[...]` syntax. Use the
list form for every multi-value class attribute.

```heex
<a class={[
  "px-2 text-white",
  @some_flag && "py-5",
  if(@other_condition, do: "border-red-500", else: "border-blue-100")
]}>Text</a>
```

Wrap `if` inside `{...}` expressions in parens, as above. Omitting the brackets
raises a compile syntax error on invalid HEEx attr syntax:

```heex
<%!-- INVALID: no [ ] --%>
<a class={
  "px-2 text-white",
  @some_flag && "py-5"
}>
```

## Literal Curly Braces

HEEx reads `{` and `}` as interpolation. To show a code snippet in a `<pre>` or
`<code>` block you **must** annotate the parent tag with
`phx-no-curly-interpolation`:

```heex
<code phx-no-curly-interpolation>
  let obj = {key: "val"}
</code>
```

Inside an annotated tag, `{` and `}` need no escaping, and dynamic Elixir still
works via `<%= ... %>`.

## Comprehensions

**Never** use `<% Enum.each %>` or any non-`for` comprehension to generate
template content. Always `<%= for item <- @collection do %>` (or the `:for`
attribute shorthand).

## No `else if`

Elixir has no `else if` / `elsif`, in templates or anywhere else. Use `cond`:

```heex
<%= cond do %>
  <% condition -> %>
    ...
  <% condition2 -> %>
    ...
  <% true -> %>
    ...
<% end %>
```

See `elixir-idioms` `references/language-traps.md` for the language-level rule.

## Forms

- Build forms with the imported `Phoenix.Component.form/1` and
  `Phoenix.Component.inputs_for/1`. **Never** `Phoenix.HTML.form_for` or
  `Phoenix.HTML.inputs_for` — both are outdated.
- Always assign a form built by `to_form/2` in the LiveView, then drive the
  template from `@form[:field]`.
- **Never** pass a changeset to `<.form for={...}>` and never access a changeset
  in the template — it will error. You are forbidden from
  `<.form for={@changeset}>` / `@changeset[:field]`.
- **Never** `<.form let={f} ...>`. Always `<.form for={@form} ...>`.

```heex
<%!-- ALWAYS --%>
<.form for={@form} id="my-form">
  <.input field={@form[:field]} type="text" />
</.form>

<%!-- NEVER --%>
<.form for={@changeset} id="my-form">
  <.input field={@changeset[:field]} type="text" />
</.form>
```

See `forms-uploads.md` for validate/save lifecycle, nested forms and uploads.

## DOM IDs

Always give key elements (forms, buttons, anything a test will reach for) a
unique DOM id: `<.form for={@form} id="product-form">`. Tests select on these
ids rather than on text; see `elixir-testing` `references/liveview-testing.md`.

## App-Wide Imports

For template helpers every LiveView, LiveComponent and `use MyAppWeb, :html`
module should see, import or alias them in `my_app_web.ex`'s `html_helpers`
block — not per-template.
