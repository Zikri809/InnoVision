"use client";

import * as React from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  DrawerClose,
} from "@/components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from "@/components/ui/sheet";

/**
 * Responsive modal context: shares both the screen size decision and the
 * desired mobile surface type ("drawer" vs "sheet") down the component tree.
 */
interface ResponsiveModalContextType {
  isDesktop: boolean;
  mobileSurface: "drawer" | "sheet";
}

const ResponsiveModalContext = React.createContext<ResponsiveModalContextType>({
  isDesktop: false,
  mobileSurface: "drawer",
});

function useResponsiveModalState() {
  return React.useContext(ResponsiveModalContext);
}

interface ResponsiveModalProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Choose mobile surface: "drawer" (default pull-up sheet with handle) or "sheet" (full-height page sheet). */
  mobileSurface?: "drawer" | "sheet";
}

export function ResponsiveModal({
  children,
  open,
  onOpenChange,
  mobileSurface = "drawer",
}: ResponsiveModalProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  const surface = isDesktop ? (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
    </Dialog>
  ) : mobileSurface === "sheet" ? (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {children}
    </Sheet>
  ) : (
    // vaul input rules (plan W5 A16, binding): handleOnly prevents
    // drag-dismiss from inside scrolling form content; repositionInputs
    // keeps inputs above the keyboard.
    <Drawer open={open} onOpenChange={onOpenChange} handleOnly repositionInputs>
      {children}
    </Drawer>
  );

  return (
    <ResponsiveModalContext.Provider value={{ isDesktop, mobileSurface }}>
      {surface}
    </ResponsiveModalContext.Provider>
  );
}

export interface ResponsiveModalTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

/**
 * The three surface primitives disagree on the composition API: vaul (Radix)
 * merges the child into its trigger via `asChild`, while Base UI (Dialog and
 * Sheet) has no `asChild` — an ignored `asChild` there makes the trigger
 * render its own <button> AROUND the child <Button>, producing a nested
 * <button> hydration error. This helper translates one shape into what the
 * active surface expects: Base UI gets `render={child}`, vaul gets
 * `asChild` + child.
 */
function surfaceTriggerProps(
  surface: "dialog" | "sheet" | "drawer",
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean },
): Record<string, unknown> {
  const { asChild, children, ...rest } = props;
  if (surface === "drawer") {
    return { asChild, children, ...rest };
  }
  if (asChild && React.isValidElement(children)) {
    return { render: children, children: undefined, ...rest };
  }
  return { children, ...rest };
}

export function ResponsiveModalTrigger({
  className,
  children,
  ...props
}: ResponsiveModalTriggerProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();
  const surface = isDesktop ? "dialog" : mobileSurface === "sheet" ? "sheet" : "drawer";
  const translated = surfaceTriggerProps(surface, { ...props, className, children });

  if (surface === "dialog") {
    return <DialogTrigger {...translated} />;
  }

  if (surface === "sheet") {
    return <SheetTrigger {...translated} />;
  }

  return <DrawerTrigger {...translated} />;
}

export interface ResponsiveModalCloseProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export function ResponsiveModalClose({
  className,
  children,
  ...props
}: ResponsiveModalCloseProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();
  const surface = isDesktop ? "dialog" : mobileSurface === "sheet" ? "sheet" : "drawer";
  const translated = surfaceTriggerProps(surface, { ...props, className, children });

  if (surface === "dialog") {
    return <DialogClose {...translated} />;
  }

  if (surface === "sheet") {
    return <SheetClose {...translated} />;
  }

  return <DrawerClose {...translated} />;
}

export type ResponsiveModalContentProps = React.HTMLAttributes<HTMLDivElement> & {
  showCloseButton?: boolean;
  /** Drawer mode only: pinned footer row (CTA) that never scrolls away. */
  footer?: React.ReactNode;
};

export function ResponsiveModalContent({
  className,
  children,
  showCloseButton,
  footer,
  ...props
}: ResponsiveModalContentProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();

  if (isDesktop) {
    return (
      <DialogContent className={className} showCloseButton={showCloseButton} {...props}>
        {children}
      </DialogContent>
    );
  }

  if (mobileSurface === "sheet") {
    return (
      <SheetContent
        side="bottom"
        showCloseButton={showCloseButton ?? false}
        className={className}
        {...props}
      >
        {children}
      </SheetContent>
    );
  }

  return (
    <DrawerContent className={className} footer={footer} {...props}>
      {children}
    </DrawerContent>
  );
}

export type ResponsiveModalHeaderProps = React.HTMLAttributes<HTMLDivElement>;

export function ResponsiveModalHeader({
  className,
  children,
  ...props
}: ResponsiveModalHeaderProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();

  if (isDesktop) {
    return (
      <DialogHeader className={className} {...props}>
        {children}
      </DialogHeader>
    );
  }

  if (mobileSurface === "sheet") {
    return (
      <SheetHeader className={className} {...props}>
        {children}
      </SheetHeader>
    );
  }

  return (
    <DrawerHeader className={className} {...props}>
      {children}
    </DrawerHeader>
  );
}

export type ResponsiveModalFooterProps = React.HTMLAttributes<HTMLDivElement>;

export function ResponsiveModalFooter({
  className,
  children,
  ...props
}: ResponsiveModalFooterProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();

  if (isDesktop) {
    return (
      <DialogFooter className={className} {...props}>
        {children}
      </DialogFooter>
    );
  }

  if (mobileSurface === "sheet") {
    return (
      <SheetFooter className={className} {...props}>
        {children}
      </SheetFooter>
    );
  }

  return (
    <DrawerFooter className={className} {...props}>
      {children}
    </DrawerFooter>
  );
}

export type ResponsiveModalTitleProps = React.HTMLAttributes<HTMLHeadingElement>;

export function ResponsiveModalTitle({
  className,
  children,
  ...props
}: ResponsiveModalTitleProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();

  if (isDesktop) {
    return (
      <DialogTitle className={className} {...props}>
        {children}
      </DialogTitle>
    );
  }

  if (mobileSurface === "sheet") {
    return (
      <SheetTitle className={className} {...props}>
        {children}
      </SheetTitle>
    );
  }

  return (
    <DrawerTitle className={className} {...props}>
      {children}
    </DrawerTitle>
  );
}

export type ResponsiveModalDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

export function ResponsiveModalDescription({
  className,
  children,
  ...props
}: ResponsiveModalDescriptionProps) {
  const { isDesktop, mobileSurface } = useResponsiveModalState();

  if (isDesktop) {
    return (
      <DialogDescription className={className} {...props}>
        {children}
      </DialogDescription>
    );
  }

  if (mobileSurface === "sheet") {
    return (
      <SheetDescription className={className} {...props}>
        {children}
      </SheetDescription>
    );
  }

  return (
    <DrawerDescription className={className} {...props}>
      {children}
    </DrawerDescription>
  );
}
