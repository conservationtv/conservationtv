import { Toast as ToastPrimitive } from "@base-ui/react/toast"

// Split out of components/toast.tsx so that file exports only components, which Fast Refresh needs to update it
// in place.

/** The app-wide toast manager; call `toast.add({ title })` anywhere. Toaster renders its toasts. */
export const toast = ToastPrimitive.createToastManager()

/** A separate manager, for a Toaster that should not show the app-wide toasts. */
export const createToastManager = ToastPrimitive.createToastManager
