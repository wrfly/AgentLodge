import { createContext } from 'react';

/**
 * Whether the block being rendered is still receiving text.
 *
 * Read by anything that would rather not redo all of its work on every delta — a code
 * block re-highlighting itself, say. A context rather than a prop: the markdown renderer
 * sits between the message and the code block, and its component table is a module-level
 * constant that takes no props.
 */
export const StreamingContext = createContext(false);
