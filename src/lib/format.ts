const useColor = Boolean(process.stdout.isTTY);

function wrap(code: string, value: string): string {
  if (!useColor) {
    return value;
  }

  return `\u001b[${code}m${value}\u001b[0m`;
}

export function bold(value: string): string {
  return wrap("1", value);
}

export function cyan(value: string): string {
  return wrap("36", value);
}

export function green(value: string): string {
  return wrap("32", value);
}

export function yellow(value: string): string {
  return wrap("33", value);
}

export function red(value: string): string {
  return wrap("31", value);
}

export function dim(value: string): string {
  return wrap("2", value);
}

export function section(title: string, body: string): string {
  return `${bold(cyan(title))}\n${body.trim()}`;
}
