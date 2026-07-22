import { createTheme, rem } from '@mantine/core';

export const opsTheme = createTheme({
  primaryColor: 'violet',
  defaultRadius: 'md',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '650',
  },
  components: {
    Button: {
      defaultProps: { radius: 'md' },
    },
    Paper: {
      defaultProps: { radius: 'lg' },
    },
    Badge: {
      defaultProps: { radius: 'sm' },
    },
    NavLink: {
      styles: {
        root: { borderRadius: rem(10) },
      },
    },
  },
});
