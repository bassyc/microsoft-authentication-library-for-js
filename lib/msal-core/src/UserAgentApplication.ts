/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { AccessTokenCacheItem } from "./cache/AccessTokenCacheItem";
import { AccessTokenKey } from "./cache/AccessTokenKey";
import { AccessTokenValue } from "./cache/AccessTokenValue";
import { ServerRequestParameters } from "./ServerRequestParameters";
import { Authority } from "./authority/Authority";
import { ClientInfo } from "./ClientInfo";
import { IdToken } from "./IdToken";
import { Logger } from "./Logger";
import { AuthCache } from "./cache/AuthCache";
import { Account } from "./Account";
import { ScopeSet } from "./ScopeSet";
import { StringUtils } from "./utils/StringUtils";
import { WindowUtils } from "./utils/WindowUtils";
import { TokenUtils } from "./utils/TokenUtils";
import { TimeUtils } from "./utils/TimeUtils";
import { UrlUtils } from "./utils/UrlUtils";
import { RequestUtils } from "./utils/RequestUtils";
import { ResponseUtils } from "./utils/ResponseUtils";
import { AuthorityFactory } from "./authority/AuthorityFactory";
import { Configuration, buildConfiguration, TelemetryOptions } from "./Configuration";
import { AuthenticationParameters } from "./AuthenticationParameters";
import { ClientConfigurationError } from "./error/ClientConfigurationError";
import { AuthError } from "./error/AuthError";
import { ClientAuthError, ClientAuthErrorMessage } from "./error/ClientAuthError";
import { ServerError } from "./error/ServerError";
import { InteractionRequiredAuthError } from "./error/InteractionRequiredAuthError";
import { AuthResponse, buildResponseStateOnly } from "./AuthResponse";
import TelemetryManager from "./telemetry/TelemetryManager";
import { TelemetryPlatform, TelemetryConfig } from "./telemetry/TelemetryTypes";
import ApiEvent, { API_CODE, API_EVENT_IDENTIFIER } from "./telemetry/ApiEvent";

import { Constants,
    ServerHashParamKeys,
    InteractionType,
    libraryVersion,
    TemporaryCacheKeys,
    PersistentCacheKeys,
    ErrorCacheKeys,
    FramePrefix
} from "./utils/Constants";
import { CryptoUtils } from "./utils/CryptoUtils";
import { TrustedAuthority } from "./authority/TrustedAuthority";

// default authority
const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";

/**
 * Interface to handle iFrame generation, Popup Window creation and redirect handling
 */
declare global {
    interface Window {
        msal: Object;
        CustomEvent: CustomEvent;
        Event: Event;
        activeRenewals: {};
        renewStates: Array<string>;
        callbackMappedToRenewStates : {};
        promiseMappedToRenewStates: {};
        openedWindows: Array<Window>;
        requestType: string;
    }
}

/**
 * @hidden
 * @ignore
 * response_type from OpenIDConnect
 * References: https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html & https://tools.ietf.org/html/rfc6749#section-4.2.1
 * Since we support only implicit flow in this library, we restrict the response_type support to only 'token' and 'id_token'
 *
 */
const ResponseTypes = {
    id_token: "id_token",
    token: "token",
    id_token_token: "id_token token"
};

/**
 * @hidden
 * @ignore
 */
export interface CacheResult {
    errorDesc: string;
    token: string;
    error: string;
}

/**
 * @hidden
 * @ignore
 * Data type to hold information about state returned from the server
 */
export type ResponseStateInfo = {
    state: string;
    timestamp: number,
    method: string;
    stateMatch: boolean;
    requestType: string;
};

/**
 * A type alias for an authResponseCallback function.
 * {@link (authResponseCallback:type)}
 * @param authErr error created for failure cases
 * @param response response containing token strings in success cases, or just state value in error cases
 */
export type authResponseCallback = (authErr: AuthError, response?: AuthResponse) => void;

/**
 * A type alias for a tokenReceivedCallback function.
 * {@link (tokenReceivedCallback:type)}
 * @returns response of type {@link (AuthResponse:type)}
 * The function that will get the call back once this API is completed (either successfully or with a failure).
 */
export type tokenReceivedCallback = (response: AuthResponse) => void;

/**
 * A type alias for a errorReceivedCallback function.
 * {@link (errorReceivedCallback:type)}
 * @returns response of type {@link (AuthError:class)}
 * @returns {string} account state
 */
export type errorReceivedCallback = (authErr: AuthError, accountState: string) => void;

/**
 * UserAgentApplication class
 *
 * Object Instance that the developer can use to make loginXX OR acquireTokenXX functions
 */
export class UserAgentApplication {

    // input Configuration by the developer/user
    private config: Configuration;

    // callbacks for token/error
    private authResponseCallback: authResponseCallback = null;
    private tokenReceivedCallback: tokenReceivedCallback = null;
    private errorReceivedCallback: errorReceivedCallback = null;

    // Added for readability as these params are very frequently used
    private logger: Logger;
    private clientId: string;
    private inCookie: boolean;
    private telemetryManager: TelemetryManager;

    // Cache and Account info referred across token grant flow
    protected cacheStorage: AuthCache;
    private account: Account;

    // state variables
    private silentAuthenticationState: string;
    private silentLogin: boolean;
    private redirectResponse: AuthResponse;
    private redirectError: AuthError;

    // Authority Functionality
    protected authorityInstance: Authority;

    /**
     * setter for the authority URL
     * @param {string} authority
     */
    // If the developer passes an authority, create an instance
    public set authority(val) {
        this.authorityInstance = AuthorityFactory.CreateInstance(val, this.config.auth.validateAuthority);
    }

    /**
     * Method to manage the authority URL.
     *
     * @returns {string} authority
     */
    public get authority(): string {
        return this.authorityInstance.CanonicalAuthority;
    }

    /**
     * Get the current authority instance from the MSAL configuration object
     *
     * @returns {@link Authority} authority instance
     */
    public getAuthorityInstance(): Authority {
        return this.authorityInstance;
    }

    /**
     * @constructor
     * Constructor for the UserAgentApplication used to instantiate the UserAgentApplication object
     *
     * Important attributes in the Configuration object for auth are:
     * - clientID: the application ID of your application.
     * You can obtain one by registering your application with our Application registration portal : https://portal.azure.com/#blade/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/RegisteredAppsPreview
     * - authority: the authority URL for your application.
     *
     * In Azure AD, authority is a URL indicating the Azure active directory that MSAL uses to obtain tokens.
     * It is of the form https://login.microsoftonline.com/&lt;Enter_the_Tenant_Info_Here&gt;.
     * If your application supports Accounts in one organizational directory, replace "Enter_the_Tenant_Info_Here" value with the Tenant Id or Tenant name (for example, contoso.microsoft.com).
     * If your application supports Accounts in any organizational directory, replace "Enter_the_Tenant_Info_Here" value with organizations.
     * If your application supports Accounts in any organizational directory and personal Microsoft accounts, replace "Enter_the_Tenant_Info_Here" value with common.
     * To restrict support to Personal Microsoft accounts only, replace "Enter_the_Tenant_Info_Here" value with consumers.
     *
     *
     * In Azure B2C, authority is of the form https://&lt;instance&gt;/tfp/&lt;tenant&gt;/&lt;policyName&gt;/
     *
     * @param {@link (Configuration:type)} configuration object for the MSAL UserAgentApplication instance
     */
    constructor(configuration: Configuration) {

        // Set the Configuration
        this.config = buildConfiguration(configuration);

        this.logger = this.config.system.logger;
        this.clientId = this.config.auth.clientId;
        this.inCookie = this.config.cache.storeAuthStateInCookie;

        this.telemetryManager = this.getTelemetryManagerFromConfig(this.config.system.telemetry, this.clientId);

        TrustedAuthority.setTrustedAuthoritiesFromConfig(this.config.auth.validateAuthority, this.config.auth.knownAuthorities);
        AuthorityFactory.saveMetadataFromConfig(this.config.auth.authority, this.config.auth.authorityMetadata);

        // if no authority is passed, set the default: "https://login.microsoftonline.com/common"
        this.authority = this.config.auth.authority || DEFAULT_AUTHORITY;

        // cache keys msal - typescript throws an error if any value other than "localStorage" or "sessionStorage" is passed
        this.cacheStorage = new AuthCache(this.clientId, this.config.cache.cacheLocation, this.inCookie);

        // Initialize window handling code
        window.activeRenewals = {};
        window.renewStates = [];
        window.callbackMappedToRenewStates = { };
        window.promiseMappedToRenewStates = { };
        window.msal = this;

        const urlHash = window.location.hash;
        const urlContainsHash = UrlUtils.urlContainsHash(urlHash);

        // check if back button is pressed
        WindowUtils.checkIfBackButtonIsPressed(this.cacheStorage);

        // On the server 302 - Redirect, handle this
        if (urlContainsHash) {
            const stateInfo = this.getResponseState(urlHash);
            if (stateInfo.method === Constants.interactionTypeRedirect) {
                this.handleRedirectAuthenticationResponse(urlHash);
            }
        }
    }

    // #region Redirect Callbacks
    /**
     * @hidden
     * @ignore
     * Set the callback functions for the redirect flow to send back the success or error object.
     * @param {@link (tokenReceivedCallback:type)} successCallback - Callback which contains the AuthResponse object, containing data from the server.
     * @param {@link (errorReceivedCallback:type)} errorCallback - Callback which contains a AuthError object, containing error data from either the server
     * or the library, depending on the origin of the error.
     */
    handleRedirectCallback(tokenReceivedCallback: tokenReceivedCallback, errorReceivedCallback: errorReceivedCallback): void;
    handleRedirectCallback(authCallback: authResponseCallback): void;
    handleRedirectCallback(authOrTokenCallback: authResponseCallback | tokenReceivedCallback, errorReceivedCallback?: errorReceivedCallback): void {
        if (!authOrTokenCallback) {
            throw ClientConfigurationError.createInvalidCallbackObjectError(authOrTokenCallback);
        }

        // Set callbacks
        if (errorReceivedCallback) {
            this.tokenReceivedCallback = authOrTokenCallback as tokenReceivedCallback;
            this.errorReceivedCallback = errorReceivedCallback;
            this.logger.warning("This overload for callback is deprecated - please change the format of the callbacks to a single callback as shown: (err: AuthError, response: AuthResponse).");
        } else {
            this.authResponseCallback = authOrTokenCallback as authResponseCallback;
        }

        if (this.redirectError) {
            this.authErrorHandler(Constants.interactionTypeRedirect, this.redirectError, this.redirectResponse);
        } else if (this.redirectResponse) {
            this.authResponseHandler(Constants.interactionTypeRedirect, this.redirectResponse);
        }
    }

    /**
     * Public API to verify if the URL contains the hash with known properties
     * @param hash
     */
    public urlContainsHash(hash: string) {
        this.logger.verbose("UrlContainsHash has been called");
        return UrlUtils.urlContainsHash(hash);
    }

    private authResponseHandler(interactionType: InteractionType, response: AuthResponse, resolve?: any) : void {
        this.logger.verbose("AuthResponseHandler has been called");

        if (interactionType === Constants.interactionTypeRedirect) {
            this.logger.verbose("Interaction type is redirect");
            if (this.errorReceivedCallback) {
                this.logger.verbose("Two callbacks were provided to handleRedirectCallback, calling success callback with response");
                this.tokenReceivedCallback(response);
            } else if (this.authResponseCallback) {
                this.logger.verbose("One callback was provided to handleRedirectCallback, calling authResponseCallback with response");
                this.authResponseCallback(null, response);
            }
        } else if (interactionType === Constants.interactionTypePopup) {
            this.logger.verbose("Interaction type is popup, resolving");
            resolve(response);
        } else {
            throw ClientAuthError.createInvalidInteractionTypeError();
        }
    }

    private authErrorHandler(interactionType: InteractionType, authErr: AuthError, response: AuthResponse, reject?: any) : void {
        this.logger.verbose("AuthErrorHandler has been called");

        // set interaction_status to complete
        this.cacheStorage.removeItem(TemporaryCacheKeys.INTERACTION_STATUS);
        if (interactionType === Constants.interactionTypeRedirect) {
            this.logger.verbose("Interaction type is redirect");
            if (this.errorReceivedCallback) {
                this.logger.verbose("Two callbacks were provided to handleRedirectCallback, calling error callback");
                this.errorReceivedCallback(authErr, response.accountState);
            } else {
                this.logger.verbose("One callback was provided to handleRedirectCallback, calling authResponseCallback with error");
                this.authResponseCallback(authErr, response);
            }
        } else if (interactionType === Constants.interactionTypePopup) {
            this.logger.verbose("Interaction type is popup, rejecting");
            reject(authErr);
        } else {
            throw ClientAuthError.createInvalidInteractionTypeError();
        }
    }

    // #endregion
    /**
     * Use when initiating the login process by redirecting the user's browser to the authorization endpoint.
     * @param {@link (AuthenticationParameters:type)}
     */
    loginRedirect(userRequest?: AuthenticationParameters): void {
        this.logger.verbose("LoginRedirect has been called");

        // validate request
        const request: AuthenticationParameters = RequestUtils.validateRequest(userRequest, true, this.clientId, Constants.interactionTypeRedirect);
        this.acquireTokenInteractive(Constants.interactionTypeRedirect, true, request,  null, null);
    }

    /**
     * Use when you want to obtain an access_token for your API by redirecting the user's browser window to the authorization endpoint.
     * @param {@link (AuthenticationParameters:type)}
     *
     * To renew idToken, please pass clientId as the only scope in the Authentication Parameters
     */
    acquireTokenRedirect(userRequest: AuthenticationParameters): void {
        this.logger.verbose("AcquireTokenRedirect has been called");

        // validate request
        const request: AuthenticationParameters = RequestUtils.validateRequest(userRequest, false, this.clientId, Constants.interactionTypeRedirect);
        this.acquireTokenInteractive(Constants.interactionTypeRedirect, false, request, null, null);
    }

    /**
     * Use when initiating the login process via opening a popup window in the user's browser
     *
     * @param {@link (AuthenticationParameters:type)}
     *
     * @returns {Promise.<AuthResponse>} - a promise that is fulfilled when this function has completed, or rejected if an error was raised. Returns the {@link AuthResponse} object
     */
    loginPopup(userRequest?: AuthenticationParameters): Promise<AuthResponse> {
        this.logger.verbose("LoginPopup has been called");

        // validate request
        const request: AuthenticationParameters = RequestUtils.validateRequest(userRequest, true, this.clientId, Constants.interactionTypePopup);
        const apiEvent: ApiEvent = this.telemetryManager.createAndStartApiEvent(request.correlationId, API_EVENT_IDENTIFIER.LoginPopup);

        return new Promise<AuthResponse>((resolve, reject) => {
            this.acquireTokenInteractive(Constants.interactionTypePopup, true, request, resolve, reject);
        })
            .then((resp) => {
                this.logger.verbose("Successfully logged in");
                this.telemetryManager.stopAndFlushApiEvent(request.correlationId, apiEvent, true);
                return resp;
            })
            .catch((error: AuthError) => {
                this.cacheStorage.resetTempCacheItems(request.state);
                this.telemetryManager.stopAndFlushApiEvent(request.correlationId, apiEvent, false, error.errorCode);
                throw error;
            });
    }

    /**
     * Use when you want to obtain an access_token for your API via opening a popup window in the user's browser
     * @param {@link AuthenticationParameters}
     *
     * To renew idToken, please pass clientId as the only scope in the Authentication Parameters
     * @returns {Promise.<AuthResponse>} - a promise that is fulfilled when this function has completed, or rejected if an error was raised. Returns the {@link AuthResponse} object
     */
    acquireTokenPopup(userRequest: AuthenticationParameters): Promise<AuthResponse> {
        this.logger.verbose("AcquireTokenPopup has been called");

        // validate request
        const request: AuthenticationParameters = RequestUtils.validateRequest(userRequest, false, this.clientId, Constants.interactionTypePopup);
        const apiEvent: ApiEvent = this.telemetryManager.createAndStartApiEvent(request.correlationId, API_EVENT_IDENTIFIER.AcquireTokenPopup);

        return new Promise<AuthResponse>((resolve, reject) => {
            this.acquireTokenInteractive(Constants.interactionTypePopup, false, request, resolve, reject);
        })
            .then((resp) => {
                this.logger.verbose("Successfully acquired token");
                this.telemetryManager.stopAndFlushApiEvent(request.correlationId, apiEvent, true);
                return resp;
            })
            .catch((error: AuthError) => {
                this.cacheStorage.resetTempCacheItems(request.state);
                this.telemetryManager.stopAndFlushApiEvent(request.correlationId, apiEvent, false, error.errorCode);
                throw error;
            });
    }

    // #region Acquire Token

    /**
     * Use when initiating the login process or when you want to obtain an access_token for your API,
     * either by redirecting the user's browser window to the authorization endpoint or via opening a popup window in the user's browser.
     * @param {@link (AuthenticationParameters:type)}
     *
     * To renew idToken, please pass clientId as the only scope in the Authentication Parameters
     */
    private acquireTokenInteractive(interactionType: InteractionType, isLoginCall: boolean, request: AuthenticationParameters, resolve?: any, reject?: any): void {
        this.logger.verbose("AcquireTokenInteractive has been called");

        // block the request if made from the hidden iframe
        WindowUtils.blockReloadInHiddenIframes();

        const interactionProgress = this.cacheStorage.getItem(TemporaryCacheKeys.INTERACTION_STATUS);
        if(interactionType === Constants.interactionTypeRedirect) {
            this.cacheStorage.setItem(TemporaryCacheKeys.REDIRECT_REQUEST, `${Constants.inProgress}${Constants.resourceDelimiter}${request.state}`);
        }

        // If already in progress, do not proceed
        if (interactionProgress === Constants.inProgress) {
            const thrownError = isLoginCall ? ClientAuthError.createLoginInProgressError() : ClientAuthError.createAcquireTokenInProgressError();
            const stateOnlyResponse = buildResponseStateOnly(this.getAccountState(request.state));
            this.cacheStorage.resetTempCacheItems(request.state);
            this.authErrorHandler(interactionType,
                thrownError,
                stateOnlyResponse,
                reject);
            return;
        }

        // Get the account object if a session exists
        let account: Account;
        if (request && request.account && !isLoginCall) {
            account = request.account;
            this.logger.verbose("Account set from request");
        } else {
            account = this.getAccount();
            this.logger.verbose("Account set from MSAL Cache");
        }

        // If no session exists, prompt the user to login.
        if (!account && !ServerRequestParameters.isSSOParam(request)) {
            if (isLoginCall) {
                // extract ADAL id_token if exists
                const adalIdToken = this.extractADALIdToken();

                // silent login if ADAL id_token is retrieved successfully - SSO
                if (adalIdToken && !request.scopes) {
                    this.logger.info("ADAL's idToken exists. Extracting login information from ADAL's idToken");
                    const tokenRequest: AuthenticationParameters = this.buildIDTokenRequest(request);

                    this.silentLogin = true;
                    this.acquireTokenSilent(tokenRequest).then(response => {
                        this.silentLogin = false;
                        this.logger.info("Unified cache call is successful");

                        this.authResponseHandler(interactionType, response, resolve);
                        return;
                    }, (error) => {
                        this.silentLogin = false;
                        this.logger.error("Error occurred during unified cache ATS: " + error);

                        // proceed to login since ATS failed
                        this.acquireTokenHelper(null, interactionType, isLoginCall, request, resolve, reject);
                    });
                }
                // No ADAL token found, proceed to login
                else {
                    this.logger.verbose("Login call but no token found, proceed to login");
                    this.acquireTokenHelper(null, interactionType, isLoginCall, request, resolve, reject);
                }
            }
            // AcquireToken call, but no account or context given, so throw error
            else {
                this.logger.verbose("AcquireToken call, no context or account given");
                this.logger.info("User login is required");
                const stateOnlyResponse = buildResponseStateOnly(this.getAccountState(request.state));
                this.cacheStorage.resetTempCacheItems(request.state);
                this.authErrorHandler(interactionType,
                    ClientAuthError.createUserLoginRequiredError(),
                    stateOnlyResponse,
                    reject);
                return;
            }
        }
        // User session exists
        else {
            this.logger.verbose("User session exists, login not required");
            this.acquireTokenHelper(account, interactionType, isLoginCall, request, resolve, reject);
        }
    }

    /**
     * @hidden
     * @ignore
     * Helper function to acquireToken
     *
     */
    private async acquireTokenHelper(account: Account, interactionType: InteractionType, isLoginCall: boolean, request: AuthenticationParameters, resolve?: any, reject?: any): Promise<void> {
        this.logger.verbose("AcquireTokenHelper has been called");
        this.logger.verbose(`Interaction type: ${interactionType}. isLoginCall: ${isLoginCall}`);

        // Track the acquireToken progress
        this.cacheStorage.setItem(TemporaryCacheKeys.INTERACTION_STATUS, Constants.inProgress);
        const scope = request.scopes ? request.scopes.join(" ").toLowerCase() : this.clientId.toLowerCase();
        this.logger.verbosePii(`Serialized scopes: ${scope}`);

        let serverAuthenticationRequest: ServerRequestParameters;
        const acquireTokenAuthority = (request && request.authority) ? AuthorityFactory.CreateInstance(request.authority, this.config.auth.validateAuthority, request.authorityMetadata) : this.authorityInstance;

        let popUpWindow: Window;

        try {
            if (!acquireTokenAuthority.hasCachedMetadata()) {
                this.logger.verbose("No cached metadata for authority");
                await AuthorityFactory.saveMetadataFromNetwork(acquireTokenAuthority, this.telemetryManager, request.correlationId);
            } else {
                this.logger.verbose("Cached metadata found for authority");
            }

            // On Fulfillment
            const responseType: string = isLoginCall ? ResponseTypes.id_token : this.getTokenType(account, request.scopes, false);

            const loginStartPage = request.redirectStartPage || window.location.href;

            serverAuthenticationRequest = new ServerRequestParameters(
                acquireTokenAuthority,
                this.clientId,
                responseType,
                this.getRedirectUri(request && request.redirectUri),
                request.scopes,
                request.state,
                request.correlationId
            );
            this.logger.verbose("Finished building server authentication request");

            this.updateCacheEntries(serverAuthenticationRequest, account, isLoginCall, loginStartPage);
            this.logger.verbose("Updating cache entries");

            // populate QueryParameters (sid/login_hint) and any other extraQueryParameters set by the developer
            serverAuthenticationRequest.populateQueryParams(account, request);
            this.logger.verbose("Query parameters populated from account");

            // Construct urlNavigate
            const urlNavigate = UrlUtils.createNavigateUrl(serverAuthenticationRequest) + Constants.response_mode_fragment;

            // set state in cache
            if (interactionType === Constants.interactionTypeRedirect) {
                if (!isLoginCall) {
                    this.cacheStorage.setItem(`${TemporaryCacheKeys.STATE_ACQ_TOKEN}${Constants.resourceDelimiter}${request.state}`, serverAuthenticationRequest.state, this.inCookie);
                    this.logger.verbose("State cached for redirect");
                    this.logger.verbosePii(`State cached: ${serverAuthenticationRequest.state}`);
                } else {
                    this.logger.verbose("Interaction type redirect but login call is true. State not cached");
                }
            } else if (interactionType === Constants.interactionTypePopup) {
                window.renewStates.push(serverAuthenticationRequest.state);
                window.requestType = isLoginCall ? Constants.login : Constants.renewToken;
                this.logger.verbose("State saved to window");
                this.logger.verbosePii(`State saved: ${serverAuthenticationRequest.state}`);

                // Register callback to capture results from server
                this.registerCallback(serverAuthenticationRequest.state, scope, resolve, reject);
            } else {
                this.logger.verbose("Invalid interaction error. State not cached");
                throw ClientAuthError.createInvalidInteractionTypeError();
            }

            if (interactionType === Constants.interactionTypePopup) {
                this.logger.verbose("Interaction type is popup. Generating popup window");
                // Generate a popup window
                try {
                    popUpWindow = this.openPopup(urlNavigate, "msal", Constants.popUpWidth, Constants.popUpHeight);
    
                    // Push popup window handle onto stack for tracking
                    WindowUtils.trackPopup(popUpWindow);
                } catch (e) {
                    this.logger.info(ClientAuthErrorMessage.popUpWindowError.code + ":" + ClientAuthErrorMessage.popUpWindowError.desc);
                    this.cacheStorage.setItem(ErrorCacheKeys.ERROR, ClientAuthErrorMessage.popUpWindowError.code);
                    this.cacheStorage.setItem(ErrorCacheKeys.ERROR_DESC, ClientAuthErrorMessage.popUpWindowError.desc);
                    if (reject) {
                        reject(ClientAuthError.createPopupWindowError());
                        return;
                    }
                }
    
                // popUpWindow will be null for redirects, so we dont need to attempt to monitor the window
                if (popUpWindow) {
                    try {
                        const hash = await WindowUtils.monitorPopupForHash(popUpWindow, this.config.system.loadFrameTimeout, urlNavigate, this.logger);

                        this.handleAuthenticationResponse(hash);

                        // Request completed successfully, set to completed
                        this.cacheStorage.removeItem(TemporaryCacheKeys.INTERACTION_STATUS);
                        this.logger.info("Closing popup window");

                        // TODO: Check how this can be extracted for any framework specific code?
                        if (this.config.framework.isAngular) {
                            this.broadcast("msal:popUpHashChanged", hash);
                            WindowUtils.closePopups();
                        }
                    } catch (error) {
                        if (reject) {
                            reject(error);
                        }

                        if (this.config.framework.isAngular) {
                            this.broadcast("msal:popUpClosed", error.errorCode + Constants.resourceDelimiter + error.errorMessage);
                        } else {
                            // Request failed, set to canceled
                            this.cacheStorage.removeItem(TemporaryCacheKeys.INTERACTION_STATUS);
                            popUpWindow.close();
                        }
                    }
                }
            } else {
                // If onRedirectNavigate is implemented, invoke it and provide urlNavigate
                if (request.onRedirectNavigate) {
                    this.logger.verbose("Invoking onRedirectNavigate callback");

                    const navigate = request.onRedirectNavigate(urlNavigate);

                    // Returning false from onRedirectNavigate will stop navigation
                    if (navigate !== false) {
                        this.logger.verbose("onRedirectNavigate did not return false, navigating");
                        this.navigateWindow(urlNavigate);
                    } else {
                        this.logger.verbose("onRedirectNavigate returned false, stopping navigation");
                    }
                } else {
                    // Otherwise, perform navigation
                    this.logger.verbose("Navigating window to urlNavigate");
                    this.navigateWindow(urlNavigate);
                }
            }
        } catch (err) {
            this.logger.error(err);
            this.cacheStorage.resetTempCacheItems(request.state);
            this.authErrorHandler(interactionType, ClientAuthError.createEndpointResolutionError(err.toString), buildResponseStateOnly(request.state), reject);
            if (popUpWindow) {
                popUpWindow.close();
            }
        }
    }

    /**
     * API interfacing idToken request when applications already have a session/hint acquired by authorization client applications
     * @param request
     */
    ssoSilent(request: AuthenticationParameters): Promise<AuthResponse> {
        this.logger.verbose("ssoSilent has been called");
        
        // throw an error on an empty request
        if (!request) {
            throw ClientConfigurationError.createEmptyRequestError();
        }

        // throw an error on no hints passed
        if (!request.sid && !request.loginHint) {
            throw ClientConfigurationError.createSsoSilentError();
        }

        return this.acquireTokenSilent({
            ...request,
            scopes: [this.clientId]
        });
    }

    /**
     * Use this function to obtain a token before every call to the API / resource provider
     *
     * MSAL return's a cached token when available
     * Or it send's a request to the STS to obtain a new token using a hidden iframe.
     *
     * @param {@link AuthenticationParameters}
     *
     * To renew idToken, please pass clientId as the only scope in the Authentication Parameters
     * @returns {Promise.<AuthResponse>} - a promise that is fulfilled when this function has completed, or rejected if an error was raised. Returns the {@link AuthResponse} object
     *
     */
    acquireTokenSilent(userRequest: AuthenticationParameters): Promise<AuthResponse> {
        this.logger.verbose("AcquireTokenSilent has been called");

        // validate the request
        const request = RequestUtils.validateRequest(userRequest, false, this.clientId, Constants.interactionTypeSilent);
        const apiEvent: ApiEvent = this.telemetryManager.createAndStartApiEvent(request.correlationId, API_EVENT_IDENTIFIER.AcquireTokenSilent);
        const requestSignature = RequestUtils.createRequestSignature(request);

        return new Promise<AuthResponse>(async (resolve, reject) => {

            // block the request if made from the hidden iframe
            WindowUtils.blockReloadInHiddenIframes();

            const scope = request.scopes.join(" ").toLowerCase();
            this.logger.verbosePii(`Serialized scopes: ${scope}`);

            // if the developer passes an account, give that account the priority
            let account: Account;
            if (request.account) {
                account = request.account;
                this.logger.verbose("Account set from request");
            } else {
                account = this.getAccount();
                this.logger.verbose("Account set from MSAL Cache");
            }

            // Extract adalIdToken if stashed in the cache to allow for seamless ADAL to MSAL migration
            const adalIdToken = this.cacheStorage.getItem(Constants.adalIdToken);

            // In the event of no account being passed in the config, no session id, and no pre-existing adalIdToken, user will need to log in
            if (!account && !(request.sid  || request.loginHint) && StringUtils.isEmpty(adalIdToken) ) {
                this.logger.info("User login is required");
                // The promise rejects with a UserLoginRequiredError, which should be caught and user should be prompted to log in interactively
                return reject(ClientAuthError.createUserLoginRequiredError());
            }

            // set the response type based on the current cache status / scopes set
            const responseType = this.getTokenType(account, request.scopes, true);
            this.logger.verbose(`Response type: ${responseType}`);

            // create a serverAuthenticationRequest populating the `queryParameters` to be sent to the Server
            const serverAuthenticationRequest = new ServerRequestParameters(
                AuthorityFactory.CreateInstance(request.authority, this.config.auth.validateAuthority, request.authorityMetadata),
                this.clientId,
                responseType,
                this.getRedirectUri(request.redirectUri),
                request.scopes,
                request.state,
                request.correlationId,
            );

            this.logger.verbose("Finished building server authentication request");

            // populate QueryParameters (sid/login_hint) and any other extraQueryParameters set by the developer
            if (ServerRequestParameters.isSSOParam(request) || account) {
                serverAuthenticationRequest.populateQueryParams(account, request, null, true);
                this.logger.verbose("Query parameters populated from existing SSO or account");
            }
            // if user didn't pass login_hint/sid and adal's idtoken is present, extract the login_hint from the adalIdToken
            else if (!account && !StringUtils.isEmpty(adalIdToken)) {
                // if adalIdToken exists, extract the SSO info from the same
                const adalIdTokenObject = TokenUtils.extractIdToken(adalIdToken);
                this.logger.verbose("ADAL's idToken exists. Extracting login information from ADAL's idToken to populate query parameters");
                serverAuthenticationRequest.populateQueryParams(account, null, adalIdTokenObject, true);
            }
            else {
                this.logger.verbose("No additional query parameters added");
            }

            const userContainedClaims = request.claimsRequest || serverAuthenticationRequest.claimsValue;

            let authErr: AuthError;
            let cacheResultResponse;

            // If request.forceRefresh is set to true, force a request for a new token instead of getting it from the cache
            if (!userContainedClaims && !request.forceRefresh) {
                try {
                    cacheResultResponse = this.getCachedToken(serverAuthenticationRequest, account);
                } catch (e) {
                    authErr = e;
                }
            }

            // resolve/reject based on cacheResult
            if (cacheResultResponse) {
                this.logger.verbose("Token found in cache lookup");
                this.logger.verbosePii(`Scopes found: ${JSON.stringify(cacheResultResponse.scopes)}`);
                resolve(cacheResultResponse);
                return null;
            }
            else if (authErr) {
                this.logger.infoPii(authErr.errorCode + ":" + authErr.errorMessage);
                reject(authErr);
                return null;
            }
            // else proceed with login
            else {
                let logMessage;
                if (userContainedClaims) {
                    logMessage = "Skipped cache lookup since claims were given";
                } else if (request.forceRefresh) {
                    logMessage = "Skipped cache lookup since request.forceRefresh option was set to true";
                } else {
                    logMessage = "No token found in cache lookup";
                }
                this.logger.verbose(logMessage);

                // Cache result can return null if cache is empty. In that case, set authority to default value if no authority is passed to the API.
                if (!serverAuthenticationRequest.authorityInstance) {
                    serverAuthenticationRequest.authorityInstance = request.authority ? AuthorityFactory.CreateInstance(request.authority, this.config.auth.validateAuthority, request.authorityMetadata) : this.authorityInstance;
                }

                this.logger.verbosePii(`Authority instance: ${serverAuthenticationRequest.authority}`);
                
                try {
                    if (!serverAuthenticationRequest.authorityInstance.hasCachedMetadata()) {
                        this.logger.verbose("No cached metadata for authority");
                        await AuthorityFactory.saveMetadataFromNetwork(serverAuthenticationRequest.authorityInstance, this.telemetryManager, request.correlationId);
                        this.logger.verbose("Authority has been updated with endpoint discovery response");
                    } else {
                        this.logger.verbose("Cached metadata found for authority");
                    }

                    /*
                     * refresh attempt with iframe
                     * Already renewing for this scope, callback when we get the token.
                     */
                    if (window.activeRenewals[requestSignature]) {
                        this.logger.verbose("Renewing token in progress. Registering callback");
                        // Active renewals contains the state for each renewal.
                        this.registerCallback(window.activeRenewals[requestSignature], requestSignature, resolve, reject);
                    }
                    else {
                        if (request.scopes && request.scopes.indexOf(this.clientId) > -1 && request.scopes.length === 1) {
                            /*
                             * App uses idToken to send to api endpoints
                             * Default scope is tracked as clientId to store this token
                             */
                            this.logger.verbose("ClientId is the only scope, renewing idToken");
                            this.silentLogin = true;
                            this.renewIdToken(requestSignature, resolve, reject, account, serverAuthenticationRequest);
                        } else {
                            // renew access token
                            this.logger.verbose("Renewing access token");
                            this.renewToken(requestSignature, resolve, reject, account, serverAuthenticationRequest);
                        }
                    }
                } catch (err) {
                    this.logger.error(err);
                    reject(ClientAuthError.createEndpointResolutionError(err.toString()));
                    return null;
                }
            }
        })
            .then(res => {
                this.logger.verbose("Successfully acquired token");
                this.telemetryManager.stopAndFlushApiEvent(request.correlationId, apiEvent, true);
                return res;
            })
            .catch((error: AuthError) => {
                this.cacheStorage.resetTempCacheItems(request.state);
                this.telemetryManager.stopAndFlushApiEvent(request.correlationId, apiEvent, false, error.errorCode);
                throw error;
            });
    }

    // #endregion

    // #region Popup Window Creation

    /**
     * @hidden
     *
     * Configures popup window for login.
     *
     * @param urlNavigate
     * @param title
     * @param popUpWidth
     * @param popUpHeight
     * @ignore
     * @hidden
     */
    private openPopup(urlNavigate: string, title: string, popUpWidth: number, popUpHeight: number) {
        this.logger.verbose("OpenPopup has been called");
        try {
            /**
             * adding winLeft and winTop to account for dual monitor
             * using screenLeft and screenTop for IE8 and earlier
             */
            const winLeft = window.screenLeft ? window.screenLeft : window.screenX;
            const winTop = window.screenTop ? window.screenTop : window.screenY;
            /**
             * window.innerWidth displays browser window"s height and width excluding toolbars
             * using document.documentElement.clientWidth for IE8 and earlier
             */
            const width = window.innerWidth || document.documentElement.clientWidth || document.body.clientWidth;
            const height = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight;
            const left = ((width / 2) - (popUpWidth / 2)) + winLeft;
            const top = ((height / 2) - (popUpHeight / 2)) + winTop;

            // open the window
            const popupWindow = window.open(urlNavigate, title, "width=" + popUpWidth + ", height=" + popUpHeight + ", top=" + top + ", left=" + left + ", scrollbars=yes");
            if (!popupWindow) {
                throw ClientAuthError.createPopupWindowError();
            }
            if (popupWindow.focus) {
                popupWindow.focus();
            }

            return popupWindow;
        } catch (e) {
            this.cacheStorage.removeItem(TemporaryCacheKeys.INTERACTION_STATUS);
            throw ClientAuthError.createPopupWindowError(e.toString());
        }
    }

    // #endregion

    // #region Iframe Management

    /**
     * @hidden
     * Calling _loadFrame but with a timeout to signal failure in loadframeStatus. Callbacks are left.
     * registered when network errors occur and subsequent token requests for same resource are registered to the pending request.
     * @ignore
     */
    private async loadIframeTimeout(urlNavigate: string, frameName: string, requestSignature: string): Promise<void> {
        // set iframe session to pending
        const expectedState = window.activeRenewals[requestSignature];
        this.logger.verbosePii("Set loading state to pending for: " + requestSignature + ":" + expectedState);
        this.cacheStorage.setItem(`${TemporaryCacheKeys.RENEW_STATUS}${Constants.resourceDelimiter}${expectedState}`, Constants.inProgress);

        // render the iframe synchronously if app chooses no timeout, else wait for the set timer to expire
        const iframe: HTMLIFrameElement = this.config.system.navigateFrameWait ?
            await WindowUtils.loadFrame(urlNavigate, frameName, this.config.system.navigateFrameWait, this.logger):
            WindowUtils.loadFrameSync(urlNavigate, frameName, this.logger);

        try {
            const hash = await WindowUtils.monitorIframeForHash(iframe.contentWindow, this.config.system.loadFrameTimeout, urlNavigate, this.logger);

            if (hash) {
                this.handleAuthenticationResponse(hash);
            }
        } catch (error) {
            if (this.cacheStorage.getItem(`${TemporaryCacheKeys.RENEW_STATUS}${Constants.resourceDelimiter}${expectedState}`) === Constants.inProgress) {
                // fail the iframe session if it's in pending state
                this.logger.verbose("Loading frame has timed out after: " + (this.config.system.loadFrameTimeout / 1000) + " seconds for scope/authority " + requestSignature + ":" + expectedState);
                // Error after timeout
                if (expectedState && window.callbackMappedToRenewStates[expectedState]) {
                    window.callbackMappedToRenewStates[expectedState](null, error);
                }

                this.cacheStorage.removeItem(`${TemporaryCacheKeys.RENEW_STATUS}${Constants.resourceDelimiter}${expectedState}`);
            }
            WindowUtils.removeHiddenIframe(iframe);
            throw error;
        }
        WindowUtils.removeHiddenIframe(iframe);
    }

    // #endregion

    // #region General Helpers

    /**
     * @hidden
     * Used to redirect the browser to the STS authorization endpoint
     * @param {string} urlNavigate - URL of the authorization endpoint
     */
    private navigateWindow(urlNavigate: string, popupWindow?: Window) {
        // Navigate if valid URL
        if (urlNavigate && !StringUtils.isEmpty(urlNavigate)) {
            const navigateWindow: Window = popupWindow ? popupWindow : window;
            const logMessage: string = popupWindow ? "Navigated Popup window to:" + urlNavigate : "Navigate to:" + urlNavigate;
            this.logger.infoPii(logMessage);
            navigateWindow.location.assign(urlNavigate);
        }
        else {
            this.logger.info("Navigate url is empty");
            throw AuthError.createUnexpectedError("Navigate url is empty");
        }
    }

    /**
     * @hidden
     * Used to add the developer requested callback to the array of callbacks for the specified scopes. The updated array is stored on the window object
     * @param {string} expectedState - Unique state identifier (guid).
     * @param {string} scope - Developer requested permissions. Not all scopes are guaranteed to be included in the access token returned.
     * @param {Function} resolve - The resolve function of the promise object.
     * @param {Function} reject - The reject function of the promise object.
     * @ignore
     */
    private registerCallback(expectedState: string, requestSignature: string, resolve: Function, reject: Function): void {
        // track active renewals
        window.activeRenewals[requestSignature] = expectedState;

        // initialize callbacks mapped array
        if (!window.promiseMappedToRenewStates[expectedState]) {
            window.promiseMappedToRenewStates[expectedState] = [];
        }
        // indexing on the current state, push the callback params to callbacks mapped
        window.promiseMappedToRenewStates[expectedState].push({ resolve: resolve, reject: reject });

        // Store the server response in the current window??
        if (!window.callbackMappedToRenewStates[expectedState]) {
            window.callbackMappedToRenewStates[expectedState] = (response: AuthResponse, error: AuthError) => {
                // reset active renewals
                window.activeRenewals[requestSignature] = null;

                // for all promiseMappedtoRenewStates for a given 'state' - call the reject/resolve with error/token respectively
                for (let i = 0; i < window.promiseMappedToRenewStates[expectedState].length; ++i) {
                    try {
                        if (error) {
                            window.promiseMappedToRenewStates[expectedState][i].reject(error);
                        } else if (response) {
                            window.promiseMappedToRenewStates[expectedState][i].resolve(response);
                        } else {
                            this.cacheStorage.resetTempCacheItems(expectedState);
                            throw AuthError.createUnexpectedError("Error and response are both null");
                        }
                    } catch (e) {
                        this.logger.warning(e);
                    }
                }

                // reset
                window.promiseMappedToRenewStates[expectedState] = null;
                window.callbackMappedToRenewStates[expectedState] = null;
            };
        }
    }

    // #endregion

    // #region Logout

    /**
     * Use to log out the current user, and redirect the user to the postLogoutRedirectUri.
     * Default behaviour is to redirect the user to `window.location.href`.
     */
    logout(correlationId?: string): void {
        this.logger.verbose("Logout has been called");
        this.logoutAsync(correlationId);
    }

    /**
     * Async version of logout(). Use to log out the current user.
     * @param correlationId Request correlationId
     */
    private async logoutAsync(correlationId?: string): Promise<void> {
        const requestCorrelationId = correlationId || CryptoUtils.createNewGuid();
        const apiEvent = this.telemetryManager.createAndStartApiEvent(requestCorrelationId, API_EVENT_IDENTIFIER.Logout);

        this.clearCache();
        this.account = null;

        try {
            if (!this.authorityInstance.hasCachedMetadata()) {
                this.logger.verbose("No cached metadata for authority");
                await AuthorityFactory.saveMetadataFromNetwork(this.authorityInstance, this.telemetryManager, correlationId);
            } else {
                this.logger.verbose("Cached metadata found for authority");
            }

            const correlationIdParam = `client-request-id=${requestCorrelationId}`;

            let postLogoutQueryParam: string;
            if (this.getPostLogoutRedirectUri()) {
                postLogoutQueryParam = `&post_logout_redirect_uri=${encodeURIComponent(this.getPostLogoutRedirectUri())}`;
                this.logger.verbose("redirectUri found and set");
            } else {
                postLogoutQueryParam = "";
                this.logger.verbose("No redirectUri set for app. postLogoutQueryParam is empty");
            }

            let urlNavigate: string;
            if (this.authorityInstance.EndSessionEndpoint) {
                urlNavigate = `${this.authorityInstance.EndSessionEndpoint}?${correlationIdParam}${postLogoutQueryParam}`;
                this.logger.verbose("EndSessionEndpoint found and urlNavigate set");
                this.logger.verbosePii(`urlNavigate set to: ${this.authorityInstance.EndSessionEndpoint}`);
            } else {
                urlNavigate = `${this.authority}oauth2/v2.0/logout?${correlationIdParam}${postLogoutQueryParam}`;
                this.logger.verbose("No endpoint, urlNavigate set to default");
            }

            this.telemetryManager.stopAndFlushApiEvent(requestCorrelationId, apiEvent, true);

            this.logger.verbose("Navigating window to urlNavigate");
            this.navigateWindow(urlNavigate);
        } catch (error) {
            this.telemetryManager.stopAndFlushApiEvent(requestCorrelationId, apiEvent, false, error.errorCode);
        }
    }

    /**
     * @hidden
     * Clear all access tokens in the cache.
     * @ignore
     */
    protected clearCache(): void {
        this.logger.verbose("Clearing cache");
        window.renewStates = [];
        const accessTokenItems = this.cacheStorage.getAllAccessTokens(Constants.clientId, Constants.homeAccountIdentifier);
        for (let i = 0; i < accessTokenItems.length; i++) {
            this.cacheStorage.removeItem(JSON.stringify(accessTokenItems[i].key));
        }
        this.cacheStorage.resetCacheItems();
        // state not being sent would mean this call may not be needed; check later
        this.cacheStorage.clearMsalCookie();
        this.logger.verbose("Cache cleared");
    }

    /**
     * @hidden
     * Clear a given access token from the cache.
     *
     * @param accessToken
     */
    protected clearCacheForScope(accessToken: string) {
        this.logger.verbose("Clearing access token from cache");
        const accessTokenItems = this.cacheStorage.getAllAccessTokens(Constants.clientId, Constants.homeAccountIdentifier);
        for (let i = 0; i < accessTokenItems.length; i++) {
            const token = accessTokenItems[i];
            if (token.value.accessToken === accessToken) {
                this.cacheStorage.removeItem(JSON.stringify(token.key));
                this.logger.verbosePii(`Access token removed: ${token.key}`);
            }
        }
    }

    // #endregion

    // #region Response

    /**
     * @hidden
     * @ignore
     * Checks if the redirect response is received from the STS. In case of redirect, the url fragment has either id_token, access_token or error.
     * @param {string} hash - Hash passed from redirect page.
     * @returns {Boolean} - true if response contains id_token, access_token or error, false otherwise.
     */
    isCallback(hash: string): boolean {
        this.logger.info("isCallback will be deprecated in favor of urlContainsHash in MSAL.js v2.0.");
        this.logger.verbose("isCallback has been called");
        return UrlUtils.urlContainsHash(hash);
    }

    /**
     * @hidden
     * Used to call the constructor callback with the token/error
     * @param {string} [hash=window.location.hash] - Hash fragment of Url.
     */
    private processCallBack(hash: string, stateInfo: ResponseStateInfo, parentCallback?: Function): void {
        this.logger.info("ProcessCallBack has been called. Processing callback from redirect response");

        // get the state info from the hash
        if (!stateInfo) {
            this.logger.verbose("StateInfo is null, getting stateInfo from hash");
            stateInfo = this.getResponseState(hash);
        }

        let response : AuthResponse;
        let authErr : AuthError;
        // Save the token info from the hash
        try {
            response = this.saveTokenFromHash(hash, stateInfo);
        } catch (err) {
            authErr = err;
        }

        try {
            // Clear the cookie in the hash
            this.cacheStorage.clearMsalCookie(stateInfo.state);
            const accountState: string = this.getAccountState(stateInfo.state);
            if (response) {
                if ((stateInfo.requestType === Constants.renewToken) || response.accessToken) {
                    if (window.parent !== window) {
                        this.logger.verbose("Window is in iframe, acquiring token silently");
                    } else {
                        this.logger.verbose("Acquiring token interactive in progress");
                    }
                    this.logger.verbose(`Response tokenType set to ${ServerHashParamKeys.ACCESS_TOKEN}`);
                    response.tokenType = ServerHashParamKeys.ACCESS_TOKEN;
                }
                else if (stateInfo.requestType === Constants.login) {
                    this.logger.verbose(`Response tokenType set to ${ServerHashParamKeys.ID_TOKEN}`);
                    response.tokenType = ServerHashParamKeys.ID_TOKEN;
                }
                if (!parentCallback) {
                    this.logger.verbose("Setting redirectResponse");
                    this.redirectResponse = response;
                    return;
                }
            } else if (!parentCallback) {
                this.logger.verbose("Response is null, setting redirectResponse with state");
                this.redirectResponse = buildResponseStateOnly(accountState);
                this.redirectError = authErr;
                this.cacheStorage.resetTempCacheItems(stateInfo.state);
                return;
            }

            this.logger.verbose("Calling callback provided to processCallback");
            parentCallback(response, authErr);
        } catch (err) {
            this.logger.error("Error occurred in token received callback function: " + err);
            throw ClientAuthError.createErrorInCallbackFunction(err.toString());
        }
    }

    /**
     * @hidden
     * This method must be called for processing the response received from the STS if using popups or iframes. It extracts the hash, processes the token or error
     * information and saves it in the cache. It then resolves the promises with the result.
     * @param {string} [hash=window.location.hash] - Hash fragment of Url.
     */
    private handleAuthenticationResponse(hash: string): void {
        this.logger.verbose("HandleAuthenticationResponse has been called");

        // retrieve the hash
        const locationHash = hash || window.location.hash;

        // if (window.parent !== window), by using self, window.parent becomes equal to window in getResponseState method specifically
        const stateInfo = this.getResponseState(locationHash);
        this.logger.verbose("Obtained state from response");

        const tokenResponseCallback = window.callbackMappedToRenewStates[stateInfo.state];
        this.processCallBack(locationHash, stateInfo, tokenResponseCallback);

        // If current window is opener, close all windows
        WindowUtils.closePopups();
    }

    /**
     * @hidden
     * This method must be called for processing the response received from the STS when using redirect flows. It extracts the hash, processes the token or error
     * information and saves it in the cache. The result can then be accessed by user registered callbacks.
     * @param {string} [hash=window.location.hash] - Hash fragment of Url.
     */
    private handleRedirectAuthenticationResponse(hash: string): void {
        this.logger.info("Returned from redirect url");
        this.logger.verbose("HandleRedirectAuthenticationResponse has been called");

        // clear hash from window
        window.location.hash = "";
        this.logger.verbose("Window.location.hash cleared");

        // if (window.parent !== window), by using self, window.parent becomes equal to window in getResponseState method specifically
        const stateInfo = this.getResponseState(hash);
        
        // if set to navigate to loginRequest page post login
        if (this.config.auth.navigateToLoginRequestUrl && window.parent === window) {
            this.logger.verbose("Window.parent is equal to window, not in popup or iframe. Navigation to login request url after login turned on");
            const loginRequestUrl = this.cacheStorage.getItem(`${TemporaryCacheKeys.LOGIN_REQUEST}${Constants.resourceDelimiter}${stateInfo.state}`, this.inCookie);

            // Redirect to home page if login request url is null (real null or the string null)
            if (!loginRequestUrl || loginRequestUrl === "null") {
                this.logger.error("Unable to get valid login request url from cache, redirecting to home page");
                window.location.assign("/");
                return;
            } else {
                this.logger.verbose("Valid login request url obtained from cache");
                const currentUrl = UrlUtils.removeHashFromUrl(window.location.href);
                const finalRedirectUrl = UrlUtils.removeHashFromUrl(loginRequestUrl);
                if (currentUrl !== finalRedirectUrl) {
                    this.logger.verbose("Current url is not login request url, navigating");
                    this.logger.verbosePii(`CurrentUrl: ${currentUrl}, finalRedirectUrl: ${finalRedirectUrl}`);
                    window.location.assign(`${finalRedirectUrl}${hash}`);
                    return;
                } else {
                    this.logger.verbose("Current url matches login request url");
                    const loginRequestUrlComponents = UrlUtils.GetUrlComponents(loginRequestUrl);
                    if (loginRequestUrlComponents.Hash){
                        this.logger.verbose("Login request url contains hash, resetting non-msal hash");
                        window.location.hash = loginRequestUrlComponents.Hash;
                    }
                }
            }
        } else if (!this.config.auth.navigateToLoginRequestUrl) {
            this.logger.verbose("Default navigation to start page after login turned off");
        }

        this.processCallBack(hash, stateInfo, null);
    }

    /**
     * @hidden
     * Creates a stateInfo object from the URL fragment and returns it.
     * @param {string} hash  -  Hash passed from redirect page
     * @returns {TokenResponse} an object created from the redirect response from AAD comprising of the keys - parameters, requestType, stateMatch, stateResponse and valid.
     * @ignore
     */
    protected getResponseState(hash: string): ResponseStateInfo {
        this.logger.verbose("GetResponseState has been called");

        const parameters = UrlUtils.deserializeHash(hash);
        let stateResponse: ResponseStateInfo;
        if (!parameters) {
            throw AuthError.createUnexpectedError("Hash was not parsed correctly.");
        }
        if (parameters.hasOwnProperty(ServerHashParamKeys.STATE)) {
            this.logger.verbose("Hash contains state. Creating stateInfo object");
            const parsedState = RequestUtils.parseLibraryState(parameters.state);

            stateResponse = {
                requestType: Constants.unknown,
                state: parameters.state,
                timestamp: parsedState.ts,
                method: parsedState.method,
                stateMatch: false
            };
        } else {
            throw AuthError.createUnexpectedError("Hash does not contain state.");
        }
        /*
         * async calls can fire iframe and login request at the same time if developer does not use the API as expected
         * incoming callback needs to be looked up to find the request type
         */

        // loginRedirect
        if (stateResponse.state === this.cacheStorage.getItem(`${TemporaryCacheKeys.STATE_LOGIN}${Constants.resourceDelimiter}${stateResponse.state}`, this.inCookie) || stateResponse.state === this.silentAuthenticationState) {
            this.logger.verbose("State matches cached state, setting requestType to login");
            stateResponse.requestType = Constants.login;
            stateResponse.stateMatch = true;
            return stateResponse;
        }
        // acquireTokenRedirect
        else if (stateResponse.state === this.cacheStorage.getItem(`${TemporaryCacheKeys.STATE_ACQ_TOKEN}${Constants.resourceDelimiter}${stateResponse.state}`, this.inCookie)) {
            this.logger.verbose("State matches cached state, setting requestType to renewToken");
            stateResponse.requestType = Constants.renewToken;
            stateResponse.stateMatch = true;
            return stateResponse;
        }

        // external api requests may have many renewtoken requests for different resource
        if (!stateResponse.stateMatch) {
            this.logger.verbose("State does not match cached state, setting requestType to type from window");
            stateResponse.requestType = window.requestType;
            const statesInParentContext = window.renewStates;
            for (let i = 0; i < statesInParentContext.length; i++) {
                if (statesInParentContext[i] === stateResponse.state) {
                    this.logger.verbose("Matching state found for request");
                    stateResponse.stateMatch = true;
                    break;
                }
            }
            if (!stateResponse.stateMatch) {
                this.logger.verbose("Matching state not found for request");
            }
        }

        return stateResponse;
    }

    // #endregion

    // #region Token Processing (Extract to TokenProcessing.ts)

    /**
     * @hidden
     * Used to get token for the specified set of scopes from the cache
     * @param {@link ServerRequestParameters} - Request sent to the STS to obtain an id_token/access_token
     * @param {Account} account - Account for which the scopes were requested
     */
    private getCachedToken(serverAuthenticationRequest: ServerRequestParameters, account: Account): AuthResponse {
        this.logger.verbose("GetCachedToken has been called");
        let accessTokenCacheItem: AccessTokenCacheItem = null;
        const scopes = serverAuthenticationRequest.scopes;

        // filter by clientId and account
        const tokenCacheItems = this.cacheStorage.getAllAccessTokens(this.clientId, account ? account.homeAccountIdentifier : null);
        this.logger.verbose("Getting all cached access tokens");

        // No match found after initial filtering
        if (tokenCacheItems.length === 0) {
            this.logger.verbose("No matching tokens found when filtered by clientId and account");
            return null;
        }

        const filteredItems: Array<AccessTokenCacheItem> = [];

        // if no authority passed
        if (!serverAuthenticationRequest.authority) {
            this.logger.verbose("No authority passed, filtering tokens by scope");
            // filter by scope
            for (let i = 0; i < tokenCacheItems.length; i++) {
                const cacheItem = tokenCacheItems[i];
                const cachedScopes = cacheItem.key.scopes.split(" ");
                if (ScopeSet.containsScope(cachedScopes, scopes)) {
                    filteredItems.push(cacheItem);
                }
            }

            // if only one cached token found
            if (filteredItems.length === 1) {
                this.logger.verbose("One matching token found, setting authorityInstance");
                accessTokenCacheItem = filteredItems[0];
                serverAuthenticationRequest.authorityInstance = AuthorityFactory.CreateInstance(accessTokenCacheItem.key.authority, this.config.auth.validateAuthority);
            }
            // if more than one cached token is found
            else if (filteredItems.length > 1) {
                throw ClientAuthError.createMultipleMatchingTokensInCacheError(scopes.toString());
            }
            // if no match found, check if there was a single authority used
            else {
                this.logger.verbose("No matching token found when filtering by scope");
                const authorityList = this.getUniqueAuthority(tokenCacheItems, "authority");
                if (authorityList.length > 1) {
                    throw ClientAuthError.createMultipleAuthoritiesInCacheError(scopes.toString());
                }

                this.logger.verbose("Single authority used, setting authorityInstance");
                serverAuthenticationRequest.authorityInstance = AuthorityFactory.CreateInstance(authorityList[0], this.config.auth.validateAuthority);
            }
        }
        // if an authority is passed in the API
        else {
            this.logger.verbose("Authority passed, filtering by authority and scope");
            // filter by authority and scope
            for (let i = 0; i < tokenCacheItems.length; i++) {
                const cacheItem = tokenCacheItems[i];
                const cachedScopes = cacheItem.key.scopes.split(" ");
                if (ScopeSet.containsScope(cachedScopes, scopes) && UrlUtils.CanonicalizeUri(cacheItem.key.authority) === serverAuthenticationRequest.authority) {
                    filteredItems.push(cacheItem);
                }
            }
            // no match
            if (filteredItems.length === 0) {
                this.logger.verbose("No matching tokens found");
                return null;
            }
            // if only one cachedToken Found
            else if (filteredItems.length === 1) {
                this.logger.verbose("Single token found");
                accessTokenCacheItem = filteredItems[0];
            }
            else {
                // if more than one cached token is found
                throw ClientAuthError.createMultipleMatchingTokensInCacheError(scopes.toString());
            }
        }

        if (accessTokenCacheItem != null) {
            this.logger.verbose("Evaluating access token found");
            const expired = Number(accessTokenCacheItem.value.expiresIn);
            // If expiration is within offset, it will force renew
            const offset = this.config.system.tokenRenewalOffsetSeconds || 300;
            if (expired && (expired > TimeUtils.now() + offset)) {
                this.logger.verbose("Token expiration is within offset, renewing token");
                const idTokenObj = new IdToken(accessTokenCacheItem.value.idToken);
                if (!account) {
                    account = this.getAccount();
                    if (!account) {
                        throw AuthError.createUnexpectedError("Account should not be null here.");
                    }
                }
                const aState = this.getAccountState(serverAuthenticationRequest.state);
                const response : AuthResponse = {
                    uniqueId: "",
                    tenantId: "",
                    tokenType: (accessTokenCacheItem.value.idToken === accessTokenCacheItem.value.accessToken) ? ServerHashParamKeys.ID_TOKEN : ServerHashParamKeys.ACCESS_TOKEN,
                    idToken: idTokenObj,
                    idTokenClaims: idTokenObj.claims,
                    accessToken: accessTokenCacheItem.value.accessToken,
                    scopes: accessTokenCacheItem.key.scopes.split(" "),
                    expiresOn: new Date(expired * 1000),
                    account: account,
                    accountState: aState,
                    fromCache: true
                };
                ResponseUtils.setResponseIdToken(response, idTokenObj);
                this.logger.verbose("Response generated and token set");
                return response;
            } else {
                this.logger.verbose("Token expired, removing from cache");
                this.cacheStorage.removeItem(JSON.stringify(filteredItems[0].key));
                return null;
            }
        } else {
            this.logger.verbose("No tokens found");
            return null;
        }
    }

    /**
     * @hidden
     * Used to get a unique list of authorities from the cache
     * @param {Array<AccessTokenCacheItem>}  accessTokenCacheItems - accessTokenCacheItems saved in the cache
     * @ignore
     */
    private getUniqueAuthority(accessTokenCacheItems: Array<AccessTokenCacheItem>, property: string): Array<string> {
        this.logger.verbose("GetUniqueAuthority has been called");
        const authorityList: Array<string> = [];
        const flags: Array<string> = [];
        accessTokenCacheItems.forEach(element => {
            if (element.key.hasOwnProperty(property) && (flags.indexOf(element.key[property]) === -1)) {
                flags.push(element.key[property]);
                authorityList.push(element.key[property]);
            }
        });
        return authorityList;
    }

    /**
     * @hidden
     * Check if ADAL id_token exists and return if exists.
     *
     */
    private extractADALIdToken(): any {
        this.logger.verbose("ExtractADALIdToken has been called");
        const adalIdToken = this.cacheStorage.getItem(Constants.adalIdToken);
        return (!StringUtils.isEmpty(adalIdToken)) ? TokenUtils.extractIdToken(adalIdToken) : null;
    }

    /**
     * @hidden
     * Acquires access token using a hidden iframe.
     * @ignore
     */
    private renewToken(requestSignature: string, resolve: Function, reject: Function, account: Account, serverAuthenticationRequest: ServerRequestParameters): void {
        this.logger.verbose("RenewToken has been called");
        this.logger.verbosePii(`RenewToken scope and authority: ${requestSignature}`);

        const frameName = WindowUtils.generateFrameName(FramePrefix.TOKEN_FRAME, requestSignature);
        WindowUtils.addHiddenIFrame(frameName, this.logger);

        this.updateCacheEntries(serverAuthenticationRequest, account, false);
        this.logger.verbosePii(`RenewToken expected state: ${serverAuthenticationRequest.state}`);

        // Build urlNavigate with "prompt=none" and navigate to URL in hidden iFrame
        const urlNavigate = UrlUtils.urlRemoveQueryStringParameter(UrlUtils.createNavigateUrl(serverAuthenticationRequest), Constants.prompt) + Constants.prompt_none + Constants.response_mode_fragment;

        window.renewStates.push(serverAuthenticationRequest.state);
        window.requestType = Constants.renewToken;
        this.logger.verbose("Set window.renewState and requestType");
        this.registerCallback(serverAuthenticationRequest.state, requestSignature, resolve, reject);
        this.logger.infoPii(`Navigate to: ${urlNavigate}`);
        this.loadIframeTimeout(urlNavigate, frameName, requestSignature).catch(error => reject(error));
    }

    /**
     * @hidden
     * Renews idtoken for app's own backend when clientId is passed as a single scope in the scopes array.
     * @ignore
     */
    private renewIdToken(requestSignature: string, resolve: Function, reject: Function, account: Account, serverAuthenticationRequest: ServerRequestParameters): void {
        this.logger.info("RenewIdToken has been called");

        const frameName = WindowUtils.generateFrameName(FramePrefix.ID_TOKEN_FRAME, requestSignature);
        WindowUtils.addHiddenIFrame(frameName, this.logger);

        this.updateCacheEntries(serverAuthenticationRequest, account, false);

        this.logger.verbose(`RenewIdToken expected state: ${serverAuthenticationRequest.state}`);

        // Build urlNavigate with "prompt=none" and navigate to URL in hidden iFrame
        const urlNavigate = UrlUtils.urlRemoveQueryStringParameter(UrlUtils.createNavigateUrl(serverAuthenticationRequest), Constants.prompt) + Constants.prompt_none + Constants.response_mode_fragment;

        if (this.silentLogin) {
            this.logger.verbose("Silent login is true, set silentAuthenticationState");
            window.requestType = Constants.login;
            this.silentAuthenticationState = serverAuthenticationRequest.state;
        } else {
            this.logger.verbose("Not silent login, set window.renewState and requestType");
            window.requestType = Constants.renewToken;
            window.renewStates.push(serverAuthenticationRequest.state);
        }

        // note: scope here is clientId
        this.registerCallback(serverAuthenticationRequest.state, requestSignature, resolve, reject);
        this.logger.infoPii(`Navigate to:" ${urlNavigate}`);
        this.loadIframeTimeout(urlNavigate, frameName, requestSignature).catch(error => reject(error));
    }

    /**
     * @hidden
     *
     * This method must be called for processing the response received from AAD. It extracts the hash, processes the token or error, saves it in the cache and calls the registered callbacks with the result.
     * @param {string} authority authority received in the redirect response from AAD.
     * @param {TokenResponse} requestInfo an object created from the redirect response from AAD comprising of the keys - parameters, requestType, stateMatch, stateResponse and valid.
     * @param {Account} account account object for which scopes are consented for. The default account is the logged in account.
     * @param {ClientInfo} clientInfo clientInfo received as part of the response comprising of fields uid and utid.
     * @param {IdToken} idToken idToken received as part of the response.
     * @ignore
     * @private
     */
    /* tslint:disable:no-string-literal */
    private saveAccessToken(response: AuthResponse, authority: string, parameters: any, clientInfo: string, idTokenObj: IdToken): AuthResponse {
        this.logger.verbose("SaveAccessToken has been called");
        let scope: string;
        const accessTokenResponse = { ...response };
        const clientObj: ClientInfo = new ClientInfo(clientInfo);
        let expiration: number;

        // if the response contains "scope"
        if (parameters.hasOwnProperty(ServerHashParamKeys.SCOPE)) {
            this.logger.verbose("Response parameters contains scope");
            // read the scopes
            scope = parameters[ServerHashParamKeys.SCOPE];
            const consentedScopes = scope.split(" ");

            // retrieve all access tokens from the cache, remove the dup scores
            const accessTokenCacheItems = this.cacheStorage.getAllAccessTokens(this.clientId, authority);
            this.logger.verbose("Retrieving all access tokens from cache and removing duplicates");

            for (let i = 0; i < accessTokenCacheItems.length; i++) {
                const accessTokenCacheItem = accessTokenCacheItems[i];

                if (accessTokenCacheItem.key.homeAccountIdentifier === response.account.homeAccountIdentifier) {
                    const cachedScopes = accessTokenCacheItem.key.scopes.split(" ");
                    if (ScopeSet.isIntersectingScopes(cachedScopes, consentedScopes)) {
                        this.cacheStorage.removeItem(JSON.stringify(accessTokenCacheItem.key));
                    }
                }
            }

            // Generate and cache accessTokenKey and accessTokenValue
            const expiresIn = TimeUtils.parseExpiresIn(parameters[ServerHashParamKeys.EXPIRES_IN]);
            const parsedState = RequestUtils.parseLibraryState(parameters[ServerHashParamKeys.STATE]);
            expiration = parsedState.ts + expiresIn;
            const accessTokenKey = new AccessTokenKey(authority, this.clientId, scope, clientObj.uid, clientObj.utid);
            const accessTokenValue = new AccessTokenValue(parameters[ServerHashParamKeys.ACCESS_TOKEN], idTokenObj.rawIdToken, expiration.toString(), clientInfo);

            this.cacheStorage.setItem(JSON.stringify(accessTokenKey), JSON.stringify(accessTokenValue));
            this.logger.verbose("Saving token to cache");

            accessTokenResponse.accessToken  = parameters[ServerHashParamKeys.ACCESS_TOKEN];
            accessTokenResponse.scopes = consentedScopes;
        }
        // if the response does not contain "scope" - scope is usually client_id and the token will be id_token
        else {
            this.logger.verbose("Response parameters does not contain scope, clientId set as scope");
            scope = this.clientId;

            // Generate and cache accessTokenKey and accessTokenValue
            const accessTokenKey = new AccessTokenKey(authority, this.clientId, scope, clientObj.uid, clientObj.utid);
            expiration = Number(idTokenObj.expiration);
            const accessTokenValue = new AccessTokenValue(parameters[ServerHashParamKeys.ID_TOKEN], parameters[ServerHashParamKeys.ID_TOKEN], expiration.toString(), clientInfo);
            this.cacheStorage.setItem(JSON.stringify(accessTokenKey), JSON.stringify(accessTokenValue));
            this.logger.verbose("Saving token to cache");
            accessTokenResponse.scopes = [scope];
            accessTokenResponse.accessToken = parameters[ServerHashParamKeys.ID_TOKEN];
        }

        if (expiration) {
            this.logger.verbose("New expiration set");
            accessTokenResponse.expiresOn = new Date(expiration * 1000);
        } else {
            this.logger.error("Could not parse expiresIn parameter");
        }

        return accessTokenResponse;
    }

    /**
     * @hidden
     * Saves token or error received in the response from AAD in the cache. In case of id_token, it also creates the account object.
     * @ignore
     */
    protected saveTokenFromHash(hash: string, stateInfo: ResponseStateInfo): AuthResponse {
        this.logger.verbose("SaveTokenFromHash has been called");
        this.logger.info(`State status: ${stateInfo.stateMatch}; Request type: ${stateInfo.requestType}`);

        let response : AuthResponse = {
            uniqueId: "",
            tenantId: "",
            tokenType: "",
            idToken: null,
            idTokenClaims: null,
            accessToken: null,
            scopes: [],
            expiresOn: null,
            account: null,
            accountState: "",
            fromCache: false
        };

        let error: AuthError;
        const hashParams = UrlUtils.deserializeHash(hash);
        let authorityKey: string = "";
        let acquireTokenAccountKey: string = "";
        let idTokenObj: IdToken = null;

        // If server returns an error
        if (hashParams.hasOwnProperty(ServerHashParamKeys.ERROR_DESCRIPTION) || hashParams.hasOwnProperty(ServerHashParamKeys.ERROR)) {
            this.logger.verbose("Server returned an error");
            this.logger.infoPii(`Error : ${hashParams[ServerHashParamKeys.ERROR]}; Error description: ${hashParams[ServerHashParamKeys.ERROR_DESCRIPTION]}`);
            this.cacheStorage.setItem(ErrorCacheKeys.ERROR, hashParams[ServerHashParamKeys.ERROR]);
            this.cacheStorage.setItem(ErrorCacheKeys.ERROR_DESC, hashParams[ServerHashParamKeys.ERROR_DESCRIPTION]);

            // login
            if (stateInfo.requestType === Constants.login) {
                this.logger.verbose("RequestType is login, caching login error, generating authorityKey");
                this.cacheStorage.setItem(ErrorCacheKeys.LOGIN_ERROR, hashParams[ServerHashParamKeys.ERROR_DESCRIPTION] + ":" + hashParams[ServerHashParamKeys.ERROR]);
                authorityKey = AuthCache.generateAuthorityKey(stateInfo.state);
            }

            // acquireToken
            if (stateInfo.requestType === Constants.renewToken) {
                this.logger.verbose("RequestType is renewToken, generating acquireTokenAccountKey");
                authorityKey = AuthCache.generateAuthorityKey(stateInfo.state);

                const account: Account = this.getAccount();
                let accountId;

                if (account && !StringUtils.isEmpty(account.homeAccountIdentifier)) {
                    accountId = account.homeAccountIdentifier;
                    this.logger.verbose("AccountId is set");
                }
                else {
                    accountId = Constants.no_account;
                    this.logger.verbose("AccountId is set as no_account");
                }

                acquireTokenAccountKey = AuthCache.generateAcquireTokenAccountKey(accountId, stateInfo.state);
            }

            const {
                [ServerHashParamKeys.ERROR]: hashErr,
                [ServerHashParamKeys.ERROR_DESCRIPTION]: hashErrDesc
            } = hashParams;
            if (InteractionRequiredAuthError.isInteractionRequiredError(hashErr) ||
        InteractionRequiredAuthError.isInteractionRequiredError(hashErrDesc)) {
                error = new InteractionRequiredAuthError(hashParams[ServerHashParamKeys.ERROR], hashParams[ServerHashParamKeys.ERROR_DESCRIPTION]);
            } else {
                error = new ServerError(hashParams[ServerHashParamKeys.ERROR], hashParams[ServerHashParamKeys.ERROR_DESCRIPTION]);
            }
        }
        // If the server returns "Success"
        else {
            this.logger.verbose("Server returns success");
            // Verify the state from redirect and record tokens to storage if exists
            if (stateInfo.stateMatch) {
                this.logger.info("State is right");
                if (hashParams.hasOwnProperty(ServerHashParamKeys.SESSION_STATE)) {
                    this.logger.verbose("Fragment has session state, caching");
                    this.cacheStorage.setItem(`${TemporaryCacheKeys.SESSION_STATE}${Constants.resourceDelimiter}${stateInfo.state}`, hashParams[ServerHashParamKeys.SESSION_STATE]);
                }
                response.accountState = this.getAccountState(stateInfo.state);

                let clientInfo: string = "";

                // Process access_token
                if (hashParams.hasOwnProperty(ServerHashParamKeys.ACCESS_TOKEN)) {
                    this.logger.info("Fragment has access token");
                    response.accessToken = hashParams[ServerHashParamKeys.ACCESS_TOKEN];

                    if (hashParams.hasOwnProperty(ServerHashParamKeys.SCOPE)) {
                        response.scopes = hashParams[ServerHashParamKeys.SCOPE].split(" ");
                    }

                    // retrieve the id_token from response if present
                    if (hashParams.hasOwnProperty(ServerHashParamKeys.ID_TOKEN)) {
                        this.logger.verbose("Fragment has id_token");
                        idTokenObj = new IdToken(hashParams[ServerHashParamKeys.ID_TOKEN]);
                        response.idToken = idTokenObj;
                        response.idTokenClaims = idTokenObj.claims;
                    } else {
                        this.logger.verbose("No idToken on fragment, getting idToken from cache");
                        idTokenObj = new IdToken(this.cacheStorage.getItem(PersistentCacheKeys.IDTOKEN));
                        response = ResponseUtils.setResponseIdToken(response, idTokenObj);
                    }

                    // set authority
                    const authority: string = this.populateAuthority(stateInfo.state, this.inCookie, this.cacheStorage, idTokenObj);
                    this.logger.verbose("Got authority from cache");

                    // retrieve client_info - if it is not found, generate the uid and utid from idToken
                    if (hashParams.hasOwnProperty(ServerHashParamKeys.CLIENT_INFO)) {
                        this.logger.verbose("Fragment has clientInfo");
                        clientInfo = hashParams[ServerHashParamKeys.CLIENT_INFO];
                    } else {
                        this.logger.warning("ClientInfo not received in the response from AAD");
                        throw ClientAuthError.createClientInfoNotPopulatedError("ClientInfo not received in the response from the server");
                    }

                    response.account = Account.createAccount(idTokenObj, new ClientInfo(clientInfo));
                    this.logger.verbose("Account object created from response");

                    let accountKey: string;
                    if (response.account && !StringUtils.isEmpty(response.account.homeAccountIdentifier)) {
                        this.logger.verbose("AccountKey set");
                        accountKey = response.account.homeAccountIdentifier;
                    }
                    else {
                        this.logger.verbose("AccountKey set as no_account");
                        accountKey = Constants.no_account;
                    }

                    acquireTokenAccountKey = AuthCache.generateAcquireTokenAccountKey(accountKey, stateInfo.state);
                    const acquireTokenAccountKey_noaccount = AuthCache.generateAcquireTokenAccountKey(Constants.no_account, stateInfo.state);
                    this.logger.verbose("AcquireTokenAccountKey generated");

                    const cachedAccount: string = this.cacheStorage.getItem(acquireTokenAccountKey);
                    let acquireTokenAccount: Account;

                    // Check with the account in the Cache
                    if (!StringUtils.isEmpty(cachedAccount)) {
                        acquireTokenAccount = JSON.parse(cachedAccount);
                        this.logger.verbose("AcquireToken request account retrieved from cache");
                        if (response.account && acquireTokenAccount && Account.compareAccounts(response.account, acquireTokenAccount)) {
                            response = this.saveAccessToken(response, authority, hashParams, clientInfo, idTokenObj);
                            this.logger.info("The user object received in the response is the same as the one passed in the acquireToken request");
                        }
                        else {
                            this.logger.warning(
                                "The account object created from the response is not the same as the one passed in the acquireToken request");
                        }
                    }
                    else if (!StringUtils.isEmpty(this.cacheStorage.getItem(acquireTokenAccountKey_noaccount))) {
                        this.logger.verbose("No acquireToken account retrieved from cache");
                        response = this.saveAccessToken(response, authority, hashParams, clientInfo, idTokenObj);
                    }
                }

                // Process id_token
                if (hashParams.hasOwnProperty(ServerHashParamKeys.ID_TOKEN)) {
                    this.logger.info("Fragment has idToken");

                    // set the idToken
                    idTokenObj = new IdToken(hashParams[ServerHashParamKeys.ID_TOKEN]);

                    response = ResponseUtils.setResponseIdToken(response, idTokenObj);
                    if (hashParams.hasOwnProperty(ServerHashParamKeys.CLIENT_INFO)) {
                        this.logger.verbose("Fragment has clientInfo");
                        clientInfo = hashParams[ServerHashParamKeys.CLIENT_INFO];
                    } else {
                        this.logger.warning("ClientInfo not received in the response from AAD");
                    }

                    // set authority
                    const authority: string = this.populateAuthority(stateInfo.state, this.inCookie, this.cacheStorage, idTokenObj);

                    this.account = Account.createAccount(idTokenObj, new ClientInfo(clientInfo));
                    response.account = this.account;
                    this.logger.verbose("Account object created from response");

                    if (idTokenObj && idTokenObj.nonce) {
                        this.logger.verbose("IdToken has nonce");
                        // check nonce integrity if idToken has nonce - throw an error if not matched
                        if (idTokenObj.nonce !== this.cacheStorage.getItem(`${TemporaryCacheKeys.NONCE_IDTOKEN}${Constants.resourceDelimiter}${stateInfo.state}`, this.inCookie)) {
                            this.account = null;
                            this.cacheStorage.setItem(ErrorCacheKeys.LOGIN_ERROR, "Nonce Mismatch. Expected Nonce: " + this.cacheStorage.getItem(`${TemporaryCacheKeys.NONCE_IDTOKEN}${Constants.resourceDelimiter}${stateInfo.state}`, this.inCookie) + "," + "Actual Nonce: " + idTokenObj.nonce);
                            this.logger.error("Nonce Mismatch.Expected Nonce: " + this.cacheStorage.getItem(`${TemporaryCacheKeys.NONCE_IDTOKEN}${Constants.resourceDelimiter}${stateInfo.state}`, this.inCookie) + "," + "Actual Nonce: " + idTokenObj.nonce);
                            error = ClientAuthError.createNonceMismatchError(this.cacheStorage.getItem(`${TemporaryCacheKeys.NONCE_IDTOKEN}${Constants.resourceDelimiter}${stateInfo.state}`, this.inCookie), idTokenObj.nonce);
                        }
                        // Save the token
                        else {
                            this.logger.verbose("Nonce matches, saving idToken to cache");
                            this.cacheStorage.setItem(PersistentCacheKeys.IDTOKEN, hashParams[ServerHashParamKeys.ID_TOKEN]);
                            this.cacheStorage.setItem(PersistentCacheKeys.CLIENT_INFO, clientInfo);

                            // Save idToken as access token for app itself
                            this.saveAccessToken(response, authority, hashParams, clientInfo, idTokenObj);
                        }
                    } else {
                        this.logger.verbose("No idToken or no nonce. Cache key for Authority set as state");
                        authorityKey = stateInfo.state;
                        acquireTokenAccountKey = stateInfo.state;

                        this.logger.error("Invalid id_token received in the response");
                        error = ClientAuthError.createInvalidIdTokenError(idTokenObj);
                        this.cacheStorage.setItem(ErrorCacheKeys.ERROR, error.errorCode);
                        this.cacheStorage.setItem(ErrorCacheKeys.ERROR_DESC, error.errorMessage);
                    }
                }
            }
            // State mismatch - unexpected/invalid state
            else {
                this.logger.verbose("State mismatch");
                authorityKey = stateInfo.state;
                acquireTokenAccountKey = stateInfo.state;

                const expectedState = this.cacheStorage.getItem(`${TemporaryCacheKeys.STATE_LOGIN}${Constants.resourceDelimiter}${stateInfo.state}`, this.inCookie);
                this.logger.error(`State Mismatch. Expected State: ${expectedState}, Actual State: ${stateInfo.state}`);
                error = ClientAuthError.createInvalidStateError(stateInfo.state, expectedState);
                this.cacheStorage.setItem(ErrorCacheKeys.ERROR, error.errorCode);
                this.cacheStorage.setItem(ErrorCacheKeys.ERROR_DESC, error.errorMessage);
            }
        }

        // Set status to completed
        this.cacheStorage.removeItem(`${TemporaryCacheKeys.RENEW_STATUS}${Constants.resourceDelimiter}${stateInfo.state}`);
        this.cacheStorage.resetTempCacheItems(stateInfo.state);
        this.logger.verbose("Status set to complete, temporary cache cleared");

        // this is required if navigateToLoginRequestUrl=false
        if (this.inCookie) {
            this.logger.verbose("InCookie is true, setting authorityKey in cookie");
            this.cacheStorage.setItemCookie(authorityKey, "", -1);
            this.cacheStorage.clearMsalCookie(stateInfo.state);
        }
        if (error) {
            // Error case, set status to cancelled
            throw error;
        }

        if (!response) {
            throw AuthError.createUnexpectedError("Response is null");
        }

        return response;
    }

    /**
     * Set Authority when saving Token from the hash
     * @param state
     * @param inCookie
     * @param cacheStorage
     * @param idTokenObj
     * @param response
     */
    private populateAuthority(state: string, inCookie: boolean, cacheStorage: AuthCache, idTokenObj: IdToken): string {
        this.logger.verbose("PopulateAuthority has been called");
        const authorityKey: string = AuthCache.generateAuthorityKey(state);
        const cachedAuthority: string = cacheStorage.getItem(authorityKey, inCookie);

        // retrieve the authority from cache and replace with tenantID
        return StringUtils.isEmpty(cachedAuthority) ? cachedAuthority : UrlUtils.replaceTenantPath(cachedAuthority, idTokenObj.tenantId);
    }

    /* tslint:enable:no-string-literal */

    // #endregion

    // #region Account

    /**
     * Returns the signed in account
     * (the account object is created at the time of successful login)
     * or null when no state is found
     * @returns {@link Account} - the account object stored in MSAL
     */
    getAccount(): Account {
        // if a session already exists, get the account from the session
        if (this.account) {
            return this.account;
        }

        // frame is used to get idToken and populate the account for the given session
        const rawIdToken = this.cacheStorage.getItem(PersistentCacheKeys.IDTOKEN);
        const rawClientInfo = this.cacheStorage.getItem(PersistentCacheKeys.CLIENT_INFO);

        if (!StringUtils.isEmpty(rawIdToken) && !StringUtils.isEmpty(rawClientInfo)) {
            const idToken = new IdToken(rawIdToken);
            const clientInfo = new ClientInfo(rawClientInfo);
            this.account = Account.createAccount(idToken, clientInfo);
            return this.account;
        }
        // if login not yet done, return null
        return null;
    }

    /**
     * @hidden
     *
     * Extracts state value from the accountState sent with the authentication request.
     * @returns {string} scope.
     * @ignore
     */
    getAccountState (state: string) {
        if (state) {
            const splitIndex = state.indexOf(Constants.resourceDelimiter);
            if (splitIndex > -1 && splitIndex + 1 < state.length) {
                return state.substring(splitIndex + 1);
            }
        }
        return state;
    }

    /**
     * Use to get a list of unique accounts in MSAL cache based on homeAccountIdentifier.
     *
     * @param {@link Array<Account>} Account - all unique accounts in MSAL cache.
     */
    getAllAccounts(): Array<Account> {
        const accounts: Array<Account> = [];
        const accessTokenCacheItems = this.cacheStorage.getAllAccessTokens(Constants.clientId, Constants.homeAccountIdentifier);

        for (let i = 0; i < accessTokenCacheItems.length; i++) {
            const idToken = new IdToken(accessTokenCacheItems[i].value.idToken);
            const clientInfo = new ClientInfo(accessTokenCacheItems[i].value.homeAccountIdentifier);
            const account: Account = Account.createAccount(idToken, clientInfo);
            accounts.push(account);
        }

        return this.getUniqueAccounts(accounts);
    }

    /**
     * @hidden
     *
     * Used to filter accounts based on homeAccountIdentifier
     * @param {Array<Account>}  Accounts - accounts saved in the cache
     * @ignore
     */
    private getUniqueAccounts(accounts: Array<Account>): Array<Account> {
        if (!accounts || accounts.length <= 1) {
            return accounts;
        }

        const flags: Array<string> = [];
        const uniqueAccounts: Array<Account> = [];
        for (let index = 0; index < accounts.length; ++index) {
            if (accounts[index].homeAccountIdentifier && flags.indexOf(accounts[index].homeAccountIdentifier) === -1) {
                flags.push(accounts[index].homeAccountIdentifier);
                uniqueAccounts.push(accounts[index]);
            }
        }

        return uniqueAccounts;
    }

    // #endregion

    // #region Angular

    /**
     * @hidden
     *
     * Broadcast messages - Used only for Angular?  *
     * @param eventName
     * @param data
     */
    private broadcast(eventName: string, data: string) {
        const evt = new CustomEvent(eventName, { detail: data });
        window.dispatchEvent(evt);
    }

    /**
     * @hidden
     *
     * Helper function to retrieve the cached token
     *
     * @param scopes
     * @param {@link Account} account
     * @param state
     * @return {@link AuthResponse} AuthResponse
     */
    protected getCachedTokenInternal(scopes : Array<string> , account: Account, state: string, correlationId?: string): AuthResponse {
        // Get the current session's account object
        const accountObject: Account = account || this.getAccount();
        if (!accountObject) {
            return null;
        }

        // Construct AuthenticationRequest based on response type; set "redirectUri" from the "request" which makes this call from Angular - for this.getRedirectUri()
        const newAuthority = this.authorityInstance ? this.authorityInstance : AuthorityFactory.CreateInstance(this.authority, this.config.auth.validateAuthority);
        const responseType = this.getTokenType(accountObject, scopes, true);

        const serverAuthenticationRequest = new ServerRequestParameters(
            newAuthority,
            this.clientId,
            responseType,
            this.getRedirectUri(),
            scopes,
            state,
            correlationId
        );

        // get cached token
        return this.getCachedToken(serverAuthenticationRequest, account);
    }

    /**
     * @hidden
     *
     * Get scopes for the Endpoint - Used in Angular to track protected and unprotected resources without interaction from the developer app
     * Note: Please check if we need to set the "redirectUri" from the "request" which makes this call from Angular - for this.getRedirectUri()
     *
     * @param endpoint
     */
    protected getScopesForEndpoint(endpoint: string) : Array<string> {
        // if user specified list of unprotectedResources, no need to send token to these endpoints, return null.
        if (this.config.framework.unprotectedResources.length > 0) {
            for (let i = 0; i < this.config.framework.unprotectedResources.length; i++) {
                if (endpoint.indexOf(this.config.framework.unprotectedResources[i]) > -1) {
                    return null;
                }
            }
        }

        // process all protected resources and send the matched one
        if (this.config.framework.protectedResourceMap.size > 0) {
            for (const key of Array.from(this.config.framework.protectedResourceMap.keys())) {
                // configEndpoint is like /api/Todo requested endpoint can be /api/Todo/1
                if (endpoint.indexOf(key) > -1) {
                    return this.config.framework.protectedResourceMap.get(key);
                }
            }
        }

        /*
         * default resource will be clientid if nothing specified
         * App will use idtoken for calls to itself
         * check if it's staring from http or https, needs to match with app host
         */
        if (endpoint.indexOf("http://") > -1 || endpoint.indexOf("https://") > -1) {
            if (UrlUtils.getHostFromUri(endpoint) === UrlUtils.getHostFromUri(this.getRedirectUri())) {
                return new Array<string>(this.clientId);
            }
        } else {
            /*
             * in angular level, the url for $http interceptor call could be relative url,
             * if it's relative call, we'll treat it as app backend call.
             */
            return new Array<string>(this.clientId);
        }

        // if not the app's own backend or not a domain listed in the endpoints structure
        return null;
    }

    /**
     * Return boolean flag to developer to help inform if login is in progress
     * @returns {boolean} true/false
     */
    public getLoginInProgress(): boolean {
        return this.cacheStorage.getItem(TemporaryCacheKeys.INTERACTION_STATUS) === Constants.inProgress;
    }

    /**
     * @hidden
     * @ignore
     *
     * @param loginInProgress
     */
    protected setInteractionInProgress(inProgress: boolean) {
        if (inProgress) {
            this.cacheStorage.setItem(TemporaryCacheKeys.INTERACTION_STATUS, Constants.inProgress);
        } else {
            this.cacheStorage.removeItem(TemporaryCacheKeys.INTERACTION_STATUS);
        }
    }

    /**
     * @hidden
     * @ignore
     *
     * @param loginInProgress
     */
    protected setloginInProgress(loginInProgress : boolean) {
        this.setInteractionInProgress(loginInProgress);
    }

    /**
     * @hidden
     * @ignore
     *
     * returns the status of acquireTokenInProgress
     */
    protected getAcquireTokenInProgress(): boolean {
        return this.cacheStorage.getItem(TemporaryCacheKeys.INTERACTION_STATUS) === Constants.inProgress;
    }

    /**
     * @hidden
     * @ignore
     *
     * @param acquireTokenInProgress
     */
    protected setAcquireTokenInProgress(acquireTokenInProgress : boolean) {
        this.setInteractionInProgress(acquireTokenInProgress);
    }

    /**
     * @hidden
     * @ignore
     *
     * returns the logger handle
     */
    getLogger() {
        return this.logger;
    }

    /**
     * Sets the logger callback.
     * @param logger Logger callback
     */
    setLogger(logger: Logger) {
        this.logger = logger;
    }

    // #endregion

    // #region Getters and Setters

    /**
     * Use to get the redirect uri configured in MSAL or null.
     * Evaluates redirectUri if its a function, otherwise simply returns its value.
     *
     * @returns {string} redirect URL
     */
    public getRedirectUri(reqRedirectUri?:  string): string {
        if(reqRedirectUri) {
            return reqRedirectUri;
        }
        else if (typeof this.config.auth.redirectUri === "function") {
            return this.config.auth.redirectUri();
        }
        return this.config.auth.redirectUri;
    }

    /**
     * Use to get the post logout redirect uri configured in MSAL or null.
     * Evaluates postLogoutredirectUri if its a function, otherwise simply returns its value.
     *
     * @returns {string} post logout redirect URL
     */
    public getPostLogoutRedirectUri(): string {
        if (typeof this.config.auth.postLogoutRedirectUri === "function") {
            return this.config.auth.postLogoutRedirectUri();
        }
        return this.config.auth.postLogoutRedirectUri;
    }

    /**
     * Use to get the current {@link Configuration} object in MSAL
     *
     * @returns {@link Configuration}
     */
    public getCurrentConfiguration(): Configuration {
        if (!this.config) {
            throw ClientConfigurationError.createNoSetConfigurationError();
        }
        return this.config;
    }

    /**
     * @ignore
     *
     * Utils function to create the Authentication
     * @param {@link account} account object
     * @param scopes
     * @param silentCall
     *
     * @returns {string} token type: id_token or access_token
     *
     */
    private getTokenType(accountObject: Account, scopes: string[], silentCall: boolean): string {
        /*
         * if account is passed and matches the account object/or set to getAccount() from cache
         * if client-id is passed as scope, get id_token else token/id_token_token (in case no session exists)
         */
        let tokenType: string;

        // acquireTokenSilent
        if (silentCall) {
            if (Account.compareAccounts(accountObject, this.getAccount())) {
                tokenType = (scopes.indexOf(this.config.auth.clientId) > -1) ? ResponseTypes.id_token : ResponseTypes.token;
            }
            else {
                tokenType  = (scopes.indexOf(this.config.auth.clientId) > -1) ? ResponseTypes.id_token : ResponseTypes.id_token_token;
            }

            return tokenType;
        }
        // all other cases
        else {
            if (!Account.compareAccounts(accountObject, this.getAccount())) {
                tokenType = ResponseTypes.id_token_token;
            }
            else {
                tokenType = (scopes.indexOf(this.clientId) > -1) ? ResponseTypes.id_token : ResponseTypes.token;
            }

            return tokenType;
        }

    }

    /**
     * @hidden
     * @ignore
     *
     * Sets the cachekeys for and stores the account information in cache
     * @param account
     * @param state
     * @hidden
     */
    private setAccountCache(account: Account, state: string) {

        // Cache acquireTokenAccountKey
        const accountId = account ? this.getAccountId(account) : Constants.no_account;

        const acquireTokenAccountKey = AuthCache.generateAcquireTokenAccountKey(accountId, state);
        this.cacheStorage.setItem(acquireTokenAccountKey, JSON.stringify(account));
    }

    /**
     * @hidden
     * @ignore
     *
     * Sets the cacheKey for and stores the authority information in cache
     * @param state
     * @param authority
     * @hidden
     */
    private setAuthorityCache(state: string, authority: string) {
        // Cache authorityKey
        const authorityKey = AuthCache.generateAuthorityKey(state);
        this.cacheStorage.setItem(authorityKey, UrlUtils.CanonicalizeUri(authority), this.inCookie);
    }

    /**
     * Updates account, authority, and nonce in cache
     * @param serverAuthenticationRequest
     * @param account
     * @hidden
     * @ignore
     */
    private updateCacheEntries(serverAuthenticationRequest: ServerRequestParameters, account: Account, isLoginCall: boolean, loginStartPage?: string) {
        // Cache Request Originator Page
        if (loginStartPage) {
            this.cacheStorage.setItem(`${TemporaryCacheKeys.LOGIN_REQUEST}${Constants.resourceDelimiter}${serverAuthenticationRequest.state}`, loginStartPage, this.inCookie);
        }

        // Cache account and authority
        if (isLoginCall) {
            // Cache the state
            this.cacheStorage.setItem(`${TemporaryCacheKeys.STATE_LOGIN}${Constants.resourceDelimiter}${serverAuthenticationRequest.state}`, serverAuthenticationRequest.state, this.inCookie);
        } else {
            this.setAccountCache(account, serverAuthenticationRequest.state);
        }
        // Cache authorityKey
        this.setAuthorityCache(serverAuthenticationRequest.state, serverAuthenticationRequest.authority);

        // Cache nonce
        this.cacheStorage.setItem(`${TemporaryCacheKeys.NONCE_IDTOKEN}${Constants.resourceDelimiter}${serverAuthenticationRequest.state}`, serverAuthenticationRequest.nonce, this.inCookie);
    }

    /**
     * Returns the unique identifier for the logged in account
     * @param account
     * @hidden
     * @ignore
     */
    private getAccountId(account: Account): any {
        // return `${account.accountIdentifier}` + Constants.resourceDelimiter + `${account.homeAccountIdentifier}`;
        let accountId: string;
        if (!StringUtils.isEmpty(account.homeAccountIdentifier)) {
            accountId = account.homeAccountIdentifier;
        }
        else {
            accountId = Constants.no_account;
        }

        return accountId;
    }

    /**
     * @ignore
     * @param extraQueryParameters
     *
     * Construct 'tokenRequest' from the available data in adalIdToken
     */
    private buildIDTokenRequest(request: AuthenticationParameters): AuthenticationParameters {

        const tokenRequest: AuthenticationParameters = {
            scopes: [this.clientId],
            authority: this.authority,
            account: this.getAccount(),
            extraQueryParameters: request.extraQueryParameters,
            correlationId: request.correlationId
        };

        return tokenRequest;
    }

    /**
     * @ignore
     * @param config
     * @param clientId
     *
     * Construct TelemetryManager from Configuration
     */
    private getTelemetryManagerFromConfig(config: TelemetryOptions, clientId: string): TelemetryManager {
        if (!config) { // if unset
            return TelemetryManager.getTelemetrymanagerStub(clientId, this.logger);
        }
        // if set then validate
        const { applicationName, applicationVersion, telemetryEmitter } = config;
        if (!applicationName || !applicationVersion || !telemetryEmitter) {
            throw ClientConfigurationError.createTelemetryConfigError(config);
        }
        // if valid then construct
        const telemetryPlatform: TelemetryPlatform = {
            applicationName,
            applicationVersion
        };
        const telemetryManagerConfig: TelemetryConfig = {
            platform: telemetryPlatform,
            clientId: clientId
        };
        return new TelemetryManager(telemetryManagerConfig, telemetryEmitter, this.logger);
    }

    // #endregion
}