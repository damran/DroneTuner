// MSP command codes (Betaflight)
export const MSP_API_VERSION = 1;
export const MSP_FC_VARIANT = 2;
export const MSP_FC_VERSION = 3;
export const MSP_BOARD_INFO = 4;
export const MSP_NAME = 10;
export const MSP_STATUS_EX = 150;
export const MSP_UID = 160;
export const MSP_FEATURE_CONFIG = 36;
export const MSP_FILTER_CONFIG = 92;
export const MSP_PID_ADVANCED = 94;
export const MSP_RC_TUNING = 111;
export const MSP_PID = 112;
export const MSP_SET_FEATURE_CONFIG = 37;
export const MSP_SET_FILTER_CONFIG = 93;
export const MSP_SET_PID_ADVANCED = 95;
export const MSP_SET_PID = 202;
export const MSP_SET_RC_TUNING = 204;
export const MSP_EEPROM_WRITE = 250;
/** Select the active PID profile (payload u8 index) or rate profile (index | 0x80).
 *  Betaflight ignores it while armed; it can never arm the craft. */
export const MSP_SELECT_SETTING = 210;
/** Rate-profile flag in MSP_SELECT_SETTING's index byte. */
export const RATEPROFILE_MASK = 0x80;
export const MSP_REBOOT = 68;
