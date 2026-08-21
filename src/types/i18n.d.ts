import en from "@/messages/en.json";

type Messages = typeof en;

declare global {
  // Use type safe message keys with `useTranslations` and `getTranslations`
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface IntlMessages extends Messages {}
}
