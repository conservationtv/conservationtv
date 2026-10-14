import { Toast as ToastPrimitive } from "@base-ui/react/toast"

// Split out of components/toast.tsx so that file exports only components, which Fast Refresh needs to update it
// in place. Base UI exposes the hook only on its Toast namespace at runtime.

/** The toasts of the nearest ToastProvider's manager. */
export const useToastManager = ToastPrimitive.useToastManager
