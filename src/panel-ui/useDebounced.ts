import { useEffect, useState } from 'react';

/** Keystroke -> query would fire a request per character; every search box here is a LIKE
 *  scan over a table, so it waits for a pause. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
