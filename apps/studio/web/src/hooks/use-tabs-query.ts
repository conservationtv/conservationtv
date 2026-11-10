import { parseAsStringLiteral, useQueryState } from 'nuqs';

/** What `<Tabs>` takes to show the tab named in the page's query string, and to change it there. */
export interface TabsQueryProps<Tab extends string> {
  value: Tab;
  onValueChange: (value: string) => void;
}

/**
 * Keeps a page's tabs in its address, as `?key=tab`, so a tab can be linked to and survives a reload, the back button
 * and leaving the page:
 *
 *   <Tabs {...useTabsQuery('tab', ['configuration', 'recording', 'outputs'])}>
 *
 * The first tab is the default, and is left out of the address. A value that names no tab reads as the first.
 */
export function useTabsQuery<const Tab extends string>(
  key: string,
  tabs: readonly [Tab, ...Tab[]]
): TabsQueryProps<Tab> {
  const parser = parseAsStringLiteral(tabs).withDefault(tabs[0]);
  const [value, setValue] = useQueryState(key, parser);
  return { value, onValueChange: next => void setValue(parser.parse(next)) };
}
