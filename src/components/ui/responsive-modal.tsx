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

interface ResponsiveModalProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ResponsiveModal({
  children,
  open,
  onOpenChange,
}: ResponsiveModalProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        {children}
      </Dialog>
    );
  }

  return (
    // vaul input rules (plan W5 A16, binding): handleOnly prevents
    // drag-dismiss from inside scrolling form content; repositionInputs
    // keeps inputs above the keyboard. handleOnly on read-only sheets too —
    // one universal rule beats per-call-site drift.
    <Drawer open={open} onOpenChange={onOpenChange} handleOnly repositionInputs>
      {children}
    </Drawer>
  );
}

export interface ResponsiveModalTriggerProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
}

export function ResponsiveModalTrigger({
  className,
  children,
  ...props
}: ResponsiveModalTriggerProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogTrigger className={className} {...props}>
        {children}
      </DialogTrigger>
    );
  }

  return (
    <DrawerTrigger className={className} {...props}>
      {children}
    </DrawerTrigger>
  );
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
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogClose className={className} {...props}>
        {children}
      </DialogClose>
    );
  }

  return (
    <DrawerClose className={className} {...props}>
      {children}
    </DrawerClose>
  );
}

export type ResponsiveModalContentProps = React.HTMLAttributes<HTMLDivElement>;

export function ResponsiveModalContent({
  className,
  children,
  ...props
}: ResponsiveModalContentProps) {
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogContent className={className} {...props}>
        {children}
      </DialogContent>
    );
  }

  return (
    <DrawerContent className={className} {...props}>
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
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogHeader className={className} {...props}>
        {children}
      </DialogHeader>
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
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogFooter className={className} {...props}>
        {children}
      </DialogFooter>
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
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogTitle className={className} {...props}>
        {children}
      </DialogTitle>
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
  const isDesktop = useMediaQuery("(min-width: 640px)");

  if (isDesktop) {
    return (
      <DialogDescription className={className} {...props}>
        {children}
      </DialogDescription>
    );
  }

  return (
    <DrawerDescription className={className} {...props}>
      {children}
    </DrawerDescription>
  );
}
