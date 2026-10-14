import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Spinner } from "@conservationtv/ui/components/spinner"
import { buttonVariants } from "@conservationtv/ui/lib/button-variants"

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /**
     * Show a spinner over the label and ignore presses. The label stays in place, hidden, so the button keeps its
     * size; the button stays focusable and isn't dimmed, and is marked busy for assistive technology.
     */
    loading?: boolean
  }

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  focusableWhenDisabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn("relative", buttonVariants({ variant, size, className }))}
      disabled={disabled || loading}
      focusableWhenDisabled={focusableWhenDisabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <span data-slot="button-label" className="invisible contents">
            {children}
          </span>
          <span
            data-slot="button-loading"
            className="absolute inset-0 flex items-center justify-center"
          >
            <Spinner />
          </span>
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}

export { Button, type ButtonProps }
