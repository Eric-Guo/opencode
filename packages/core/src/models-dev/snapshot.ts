import text from "./snapshot.txt" with { type: "text" }

// The Node executable replaces this loader with a read from its packaged assets.
export function load() {
  return text
}
