/**
 * Dependency re-exports for the browser bundle.
 *
 * During bundling these are marked as external and loaded from the DSH
 * client runtime instead of being bundled into the plugin.
 */
export {
  createElement as h,
  Fragment,
  useCallback,
  useState,
  useEffect,
  useRef,
} from 'react'