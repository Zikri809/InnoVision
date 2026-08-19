import en from "@/messages/en.json";

type Messages = typeof en;

declare global {
  // Use type safe message keys with `useTranslations` and `getTranslations`
  interface IntlMessages extends Messages {}
}
